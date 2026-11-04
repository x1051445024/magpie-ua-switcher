// ua-switcher's Claude Code identity: the metadata.user_id a real Claude Code
// install sends, as a persistent device+account base and a session id.
//
// This used to live in hooks.mjs, the gateway request hook (magpie.hooks).
// That hook made magpie copy *every* agent request body — the whole history,
// the system prompt, the tool schemas — across the RPC into the Bun plugin
// host and deep-clone it there, even on the requests the hook then left alone
// (see CHANGELOG 1.8.0). The value it injected is a per-install constant
// string, so it rides magpie's own provider `extraBody` instead, which the
// gateway merges in Go as the body goes out. Nothing about the request has to
// reach JavaScript any more.
//
// A helper module, not an entry export: magpie's host calls every function the
// entry module exports as a plugin (internal/plugin/host.js servers()).

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { useridPath } from "./paths.mjs"

// profiles whose anthropic form is Claude Code's identity
export const CLAUDE_CODE_PROFILES = new Set(["claude-code", "pi"])

export const USER_ID_RE = /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/i
export const BASE_ID_RE = /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}$/i
const SESSION_TTL_MS = 4 * 3600 * 1000

// Whether an extraBody `metadata` is exactly what this plugin writes.
//
// Ownership is decided by the value, not by the ledger's word, so that a
// provider whose metadata the user edited in magpie's GUI is never deleted on
// the next switch. The strongest test is the base id this install persists:
// every id we ever wrote from this machine starts with it, whatever the
// session part looks like, so a rotated or rewritten value is still ours, and
// a real id the user copied from their own `~/.claude.json` (a different base)
// is not ours to touch. Only when no base id can be read at all — no file yet,
// or an unreadable one — does the ledger decide.
export function peekBaseId() {
  if (memoBaseId) return memoBaseId
  try {
    const j = JSON.parse(fs.readFileSync(useridPath(), "utf8"))
    if (typeof j?.base_id === "string" && BASE_ID_RE.test(j.base_id)) return j.base_id
    if (typeof j?.user_id === "string" && USER_ID_RE.test(j.user_id)) {
      return j.user_id.replace(/_session_[0-9a-f-]{36}$/i, "")
    }
  } catch {}
  return ""
}

export function isOurMetadata(md, opts = {}) {
  if (!md || typeof md !== "object" || Array.isArray(md)) return false
  const keys = Object.keys(md)
  if (keys.length !== 1 || keys[0] !== "user_id") return false
  const value = md.user_id
  if (typeof value !== "string" || !USER_ID_RE.test(value)) return false
  const base = opts.baseId === undefined ? peekBaseId() : opts.baseId
  if (base) return value.startsWith(`${base}_session_`)
  return Boolean(opts.recordedInLedger)
}

let memoUserIdPath = ""
let memoBaseId = ""
let memoSessionId = ""
let sessionCreatedAt = 0

function safeRenameSync(tmp, target) {
  for (let i = 0; i < 3; i++) {
    try {
      fs.renameSync(tmp, target)
      return
    } catch (e) {
      if (i === 2 || (e?.code !== "EPERM" && e?.code !== "EACCES" && e?.code !== "EBUSY")) {
        try {
          fs.copyFileSync(tmp, target)
          try { fs.unlinkSync(tmp) } catch {}
          return
        } catch {}
        try { fs.unlinkSync(tmp) } catch {}
        throw e
      }
    }
  }
}

// Persistent device+account identity across restarts, paired with a session
// UUID that stays stable within a session window (4h) and rotates across boots.
export function userId() {
  const file = useridPath()
  if (file !== memoUserIdPath) {
    memoUserIdPath = file
    memoBaseId = ""
  }
  const now = Date.now()
  if (!memoSessionId || now - sessionCreatedAt > SESSION_TTL_MS) {
    memoSessionId = crypto.randomUUID()
    sessionCreatedAt = now
  }
  if (!memoBaseId) {
    try {
      const j = JSON.parse(fs.readFileSync(file, "utf8"))
      if (typeof j?.base_id === "string" && BASE_ID_RE.test(j.base_id)) {
        memoBaseId = j.base_id
      } else if (typeof j?.user_id === "string" && USER_ID_RE.test(j.user_id)) {
        memoBaseId = j.user_id.replace(/_session_[0-9a-f-]{36}$/i, "")
      }
    } catch {}
    if (!memoBaseId) {
      memoBaseId = `user_${crypto.randomBytes(32).toString("hex")}_account_${crypto.randomUUID()}`
    }
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      const tmp = `${file}.${process.pid}.tmp`
      const fullId = `${memoBaseId}_session_${memoSessionId}`
      fs.writeFileSync(tmp, JSON.stringify({ base_id: memoBaseId, user_id: fullId }, null, 2) + "\n", { mode: 0o600 })
      safeRenameSync(tmp, file)
    } catch {}
  }
  return `${memoBaseId}_session_${memoSessionId}`
}

// Drop the in-memory identity so the next userId() re-reads the file. Used
// when the config folder moves (paths.mjs) and by the self-test.
export function resetUserIdMemo() {
  memoUserIdPath = ""
  memoBaseId = ""
  memoSessionId = ""
  sessionCreatedAt = 0
}

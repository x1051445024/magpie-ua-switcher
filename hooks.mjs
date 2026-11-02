// ua-switcher's gateway hook (magpie.hooks): fills in the metadata.user_id a
// real Claude Code request carries, so relays that check for the complete
// Claude Code identity accept our rewritten requests.
//
// magpie runs this module inside the plugin host for every agent request:
// onRequest(body, ctx) may return a new body, and metadata is a field the
// gateway lets a hook change (tools, model and streaming are protected).
//
// Scope: only the anthropic wire, only while the effective profile presents
// Claude Code's identity (claude-code, or pi's anthropic form), never for a
// provider the config excludes, and never over a user_id the client sent.

import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { configPath, providersPath, toolsLogPath, useridPath } from "./paths.mjs"

// profiles whose anthropic form is Claude Code's identity
const CLAUDE_CODE_PROFILES = new Set(["claude-code", "pi"])

const USER_ID_RE = /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/i
const BASE_ID_RE = /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}$/i
const STAT_TTL_MS = 300
const SESSION_TTL_MS = 4 * 3600 * 1000

let cfgCache = { path: "", mtime: -1, checkedAt: 0, cfg: null }
let idsCache = { path: "", mtime: -1, checkedAt: 0, ids: [] }
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

function canUseTtl() {
  return !process.env.UA_SWITCHER_CONFIG && !process.env.UA_SWITCHER_PROVIDERS
}

function loadCfg() {
  const file = configPath()
  const now = Date.now()
  if (file === cfgCache.path && cfgCache.cfg && canUseTtl() && now - cfgCache.checkedAt < STAT_TTL_MS) {
    return cfgCache.cfg
  }
  let st
  try {
    st = fs.statSync(file)
  } catch {
    cfgCache = { path: file, mtime: -1, checkedAt: now, cfg: null }
    return null
  }
  cfgCache.checkedAt = now
  if (file === cfgCache.path && st.mtimeMs === cfgCache.mtime) return cfgCache.cfg
  let cfg = {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) cfg = raw
  } catch {}
  cfgCache = { path: file, mtime: st.mtimeMs, checkedAt: now, cfg }
  return cfg
}

// provider ids from providers.json, to tell a "provider/model" request model
// apart from a routing group's name (group/..., auto/...).
function providerIds() {
  const file = providersPath()
  const now = Date.now()
  if (file === idsCache.path && idsCache.mtime !== -1 && canUseTtl() && now - idsCache.checkedAt < STAT_TTL_MS) {
    return idsCache.ids
  }
  let st
  try {
    st = fs.statSync(file)
  } catch {
    idsCache = { path: file, mtime: -1, checkedAt: now, ids: [] }
    return []
  }
  idsCache.checkedAt = now
  if (file === idsCache.path && st.mtimeMs === idsCache.mtime) return idsCache.ids
  const ids = []
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    for (const p of j?.providers ?? []) if (p && typeof p.id === "string") ids.push(p.id)
  } catch {}
  idsCache = { path: file, mtime: st.mtimeMs, checkedAt: now, ids }
  return ids
}

function providerOf(model) {
  if (typeof model !== "string") return ""
  const cut = model.indexOf("/")
  if (cut <= 0) return ""
  const head = model.slice(0, cut)
  return providerIds().includes(head) ? head : ""
}

// Persistent device+account identity across restarts, paired with a session
// UUID that stays stable within a session window (4h) and rotates across boots.
function userId() {
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

// diagnose (config "diagnose": true): record which tool schemas the client
// sends that Anthropic would reject — a top-level oneOf/allOf/anyOf, or a
// missing top-level type. Read-only: the request is never modified.
function oddSchemas(tools) {
  const out = []
  if (!Array.isArray(tools)) return out
  for (const t of tools) {
    if (!t || typeof t !== "object") continue
    const s = t.input_schema ?? t.inputSchema ?? t.parameters
    if (!s || typeof s !== "object" || Array.isArray(s)) continue
    const top = ["oneOf", "allOf", "anyOf"].filter((k) => k in s)
    const entry = { name: t.name ?? "", top, keys: Object.keys(s) }
    if (top.length || !("type" in s)) out.push(entry)
  }
  return out
}

function diagnose(body, ctx) {
  try {
    const tools = body?.tools
    const count = Array.isArray(tools) ? tools.length : 0
    if (!count) return // magpie's own calls (titles, classifiers) carry no tools
    const report = {
      at: new Date().toISOString(),
      protocol: ctx?.protocol ?? "",
      model: ctx?.model ?? "",
      agent: ctx?.agent ?? "",
      toolCount: count,
      names: Array.isArray(tools) ? tools.map((t) => t?.name ?? "") : [],
      odd: oddSchemas(tools),
    }
    const f = toolsLogPath()
    let all = []
    try {
      const prev = JSON.parse(fs.readFileSync(f, "utf8"))
      if (Array.isArray(prev)) all = prev
    } catch {}
    all.push(report)
    const tmp = `${f}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(all.slice(-20), null, 2) + "\n", { mode: 0o600 })
    safeRenameSync(tmp, f)
  } catch {}
}

export async function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return
    const cfg0 = loadCfg()
    if (cfg0?.diagnose === true) diagnose(body, ctx)
    if (ctx?.protocol !== "anthropic") return
    const cfg = cfg0
    if (!cfg || cfg.injectMetadata === false) return
    const provider = providerOf(ctx?.model)
    const excludes = Array.isArray(cfg.excludeProviders) ? cfg.excludeProviders : []
    if (provider && excludes.includes(provider)) return
    const overrides = cfg.providerOverrides && typeof cfg.providerOverrides === "object" ? cfg.providerOverrides : {}
    const wanted = (provider && typeof overrides[provider] === "string" && overrides[provider]) || cfg.profile || "off"
    if (!CLAUDE_CODE_PROFILES.has(wanted)) return
    const md = body.metadata
    if (md && typeof md === "object" && !Array.isArray(md) && typeof md.user_id === "string" && md.user_id) return // the client's own
    return { ...body, metadata: { ...(md && typeof md === "object" && !Array.isArray(md) ? md : {}), user_id: userId() } }
  } catch {
    return // a hook must never break the request
  }
}

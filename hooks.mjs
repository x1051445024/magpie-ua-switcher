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
import os from "node:os"
import path from "node:path"

const MAGPIE_DIR = path.join(os.homedir(), ".config", "magpie")
const CONFIG_PATH = process.env.UA_SWITCHER_CONFIG || path.join(MAGPIE_DIR, "ua-switcher.json")
const PROVIDERS_PATH = process.env.UA_SWITCHER_PROVIDERS || path.join(MAGPIE_DIR, "providers.json")
const USERID_PATH = CONFIG_PATH.replace(/\.json$/, "") + "-userid.json"

// profiles whose anthropic form is Claude Code's identity
const CLAUDE_CODE_PROFILES = new Set(["claude-code", "pi"])

const USER_ID_RE = /^user_[0-9a-f]{32,128}_account_/

let cfgCache = { mtime: -1, cfg: null }
let idsCache = { mtime: -1, ids: [] }
let memoUserId = ""

function loadCfg() {
  let st
  try {
    st = fs.statSync(CONFIG_PATH)
  } catch {
    return null
  }
  if (st.mtimeMs === cfgCache.mtime) return cfgCache.cfg
  let cfg = {}
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) cfg = raw
  } catch {}
  cfgCache = { mtime: st.mtimeMs, cfg }
  return cfg
}

// provider ids from providers.json, to tell a "provider/model" request model
// apart from a routing group's name (group/..., auto/...).
function providerIds() {
  let st
  try {
    st = fs.statSync(PROVIDERS_PATH)
  } catch {
    return []
  }
  if (st.mtimeMs === idsCache.mtime) return idsCache.ids
  const ids = []
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf8"))
    for (const p of j?.providers ?? []) if (p && typeof p.id === "string") ids.push(p.id)
  } catch {}
  idsCache = { mtime: st.mtimeMs, ids }
  return ids
}

function providerOf(model) {
  if (typeof model !== "string") return ""
  const cut = model.indexOf("/")
  if (cut <= 0) return ""
  const head = model.slice(0, cut)
  return providerIds().includes(head) ? head : ""
}

// One stable id per installation, so an upstream sees the same "user" across
// requests and restarts instead of a new account every turn.
function userId() {
  if (memoUserId) return memoUserId
  try {
    const j = JSON.parse(fs.readFileSync(USERID_PATH, "utf8"))
    if (typeof j?.user_id === "string" && USER_ID_RE.test(j.user_id)) {
      memoUserId = j.user_id
      return memoUserId
    }
  } catch {}
  const id = `user_${crypto.randomBytes(32).toString("hex")}_account_${crypto.randomUUID()}_session_${crypto.randomUUID()}`
  memoUserId = id
  try {
    fs.mkdirSync(path.dirname(USERID_PATH), { recursive: true })
    const tmp = `${USERID_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ user_id: id }, null, 2) + "\n")
    fs.renameSync(tmp, USERID_PATH)
  } catch {}
  return id
}

export async function onRequest(body, ctx) {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return
    if (ctx?.protocol !== "anthropic") return
    const cfg = loadCfg()
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

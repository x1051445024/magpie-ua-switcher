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
import { besideConfig, configPath, providersPath } from "./paths.mjs"

// Paths are asked for on each use: this module is imported before the plugin
// function learns magpie's folder (paths.mjs).

// profiles whose anthropic form is Claude Code's identity
const CLAUDE_CODE_PROFILES = new Set(["claude-code", "pi"])

const USER_ID_RE = /^user_[0-9a-f]{32,128}_account_/

let cfgCache = { path: "", mtime: -1, cfg: null }
let idsCache = { path: "", mtime: -1, ids: [] }
let memoUserId = ""

function loadCfg() {
  const file = configPath()
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return null
  }
  if (file === cfgCache.path && st.mtimeMs === cfgCache.mtime) return cfgCache.cfg
  let cfg = {}
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"))
    if (raw && typeof raw === "object" && !Array.isArray(raw)) cfg = raw
  } catch {}
  cfgCache = { path: file, mtime: st.mtimeMs, cfg }
  return cfg
}

// provider ids from providers.json, to tell a "provider/model" request model
// apart from a routing group's name (group/..., auto/...).
function providerIds() {
  const file = providersPath()
  let st
  try {
    st = fs.statSync(file)
  } catch {
    return []
  }
  if (file === idsCache.path && st.mtimeMs === idsCache.mtime) return idsCache.ids
  const ids = []
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    for (const p of j?.providers ?? []) if (p && typeof p.id === "string") ids.push(p.id)
  } catch {}
  idsCache = { path: file, mtime: st.mtimeMs, ids }
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
  const file = besideConfig("-userid.json")
  try {
    const j = JSON.parse(fs.readFileSync(file, "utf8"))
    if (typeof j?.user_id === "string" && USER_ID_RE.test(j.user_id)) {
      memoUserId = j.user_id
      return memoUserId
    }
  } catch {}
  const id = `user_${crypto.randomBytes(32).toString("hex")}_account_${crypto.randomUUID()}_session_${crypto.randomUUID()}`
  memoUserId = id
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, JSON.stringify({ user_id: id }, null, 2) + "\n")
    fs.renameSync(tmp, file)
  } catch {}
  return id
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
    const f = besideConfig("-tools.json")
    let all = []
    try {
      const prev = JSON.parse(fs.readFileSync(f, "utf8"))
      if (Array.isArray(prev)) all = prev
    } catch {}
    all.push(report)
    fs.writeFileSync(f, JSON.stringify(all.slice(-20), null, 2) + "\n")
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

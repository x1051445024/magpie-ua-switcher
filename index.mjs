// ua-switcher — switch the User-Agent (and companion identity headers) magpie
// sends upstream: Codex CLI / Claude Code / pi / ZCode / custom profiles.
//
// The rewrite rides the `chat.headers` hook, which magpie's plugin host
// applies last, over every other header source (SDK defaults, auth loader,
// headers passed in by the main app). Switching is done from a tiny local
// web page (default http://127.0.0.1:3426), by curl, or by editing
// ~/.config/magpie/ua-switcher.json — all hot, no magpie restart needed.
//
// Known limits: chat.headers can add and override headers, not remove them;
// the zcode provider's Start-Plan (-Trial) models rebuild their headers
// entirely, so this plugin cannot (and should not) touch those.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const MAGPIE_DIR = path.join(os.homedir(), ".config", "magpie")
const CONFIG_PATH = process.env.UA_SWITCHER_CONFIG || path.join(MAGPIE_DIR, "ua-switcher.json")
const PROVIDERS_PATH = process.env.UA_SWITCHER_PROVIDERS || path.join(MAGPIE_DIR, "providers.json")
const DEFAULT_PORT = 3426

// Client versions the UA strings name. Built-ins are the floor; codex /
// claude-code / aiSdk refresh themselves from npm in the background (see
// fetchLatestVersions), and "versions" in the config pins any key by hand —
// a pin always beats a fetched value. pi and zcode ship no registry to read,
// so they move only when bumped here or pinned.
const DEFAULT_VERSIONS = {
  codex: "0.164.0",
  "claude-code": "2.1.310",
  pi: "2.1.75", // the claude-cli identity pi presents on Anthropic-style APIs
  zcode: "3.16.3",
  aiSdk: "3.0.81", // the ai-sdk suffix ZCode's UA carries
}

// npm packages behind the auto-updated versions. aiSdk is deliberately not
// here: what a closed client (ZCode) bundles internally is not npm's latest,
// and a version its real UA never carried is worse than a stale one.
const NPM_PACKAGES = {
  codex: "@openai/codex",
  "claude-code": "@anthropic-ai/claude-code",
}
const REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"]
const VERSIONS_PATH = CONFIG_PATH.replace(/\.json$/, "") + "-versions.json"

// codex and pi build their UA's OS segment from the machine they run on, so
// the switcher does the same instead of naming one fixed machine. codex is
// Rust and names arches the Rust way (x64 → x86_64).
const OS_TYPE = { Windows_NT: "Windows", Darwin: "macOS", Linux: "Linux" }[os.type()] ?? os.type()
const RUST_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86" }[process.arch] ?? process.arch
const CODEX_OS_SEG = `${OS_TYPE} ${os.release()}; ${RUST_ARCH}`
const TERMINAL = os.platform() === "win32" ? "WindowsTerminal" : "unknown"

// Header sets matching the real clients. Built per call from the effective
// versions, so a background version refresh changes the UA without a reload.
function builtinProfiles(V) {
  const profiles = {
    codex: {
      label: "Codex CLI",
      ua: `codex_cli_rs/${V.codex} (${CODEX_OS_SEG}) ${TERMINAL}`,
      headers: {
        any: { originator: "codex_cli_rs" },
        openai: { "OpenAI-Beta": "responses=experimental" },
      },
    },
    "claude-code": {
      label: "Claude Code",
      ua: `claude-cli/${V["claude-code"]} (external, cli)`,
      headers: {
        any: { "X-App": "cli" },
        anthropic: {
          "anthropic-version": "2023-06-01",
          "anthropic-beta":
            "claude-code-20250219,interleaved-thinking-2025-05-14,thinking-token-count-2026-05-13,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20",
          "X-Stainless-Lang": "js",
          "X-Stainless-Package-Version": "0.112.1",
          "X-Stainless-Os": "Windows",
          "X-Stainless-Arch": "x64",
          "X-Stainless-Runtime": "node",
          "X-Stainless-Runtime-Version": "v26.3.0",
        },
      },
    },
    // pi presents two identities, exactly as the real client does: Claude
    // Code's on Anthropic-style APIs, its own on OpenAI responses endpoints.
    pi: {
      label: "pi（按协议自动）",
      forms: {
        anthropic: {
          ua: "claude-cli/2.1.75",
          headers: {
            any: { "x-app": "cli" },
            anthropic: {
              "anthropic-beta": "claude-code-20250219,oauth-2025-04-20",
              "anthropic-dangerous-direct-browser-access": "true",
            },
          },
        },
        openai: {
          ua: `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
          headers: {
            any: { originator: "pi" },
            openai: { "OpenAI-Beta": "responses=experimental" },
          },
        },
        default: {
          ua: `pi (${os.platform()} ${os.release()}; ${os.arch()})`,
          headers: { any: { originator: "pi" } },
        },
      },
    },
    zcode: {
      label: "ZCode 客户端",
      ua: `ZCode/${V.zcode} ai-sdk/anthropic/${V.aiSdk}`,
      headers: {
        anthropic: {
          "HTTP-Referer": "https://zcode.z.ai",
          "X-ZCode-App-Version": V.zcode,
          "X-Title": "Z Code@cli",
          "X-Release-Channel": "production",
          "X-ZCode-Agent": "glm",
          "X-Platform": "win32-x64",
          "X-Os-Category": "windows",
        },
      },
    },
  }
  // The real device id magpie's zcode-auth uses, when present.
  try {
    const mid = fs.readFileSync(path.join(MAGPIE_DIR, "zcode-device-mid"), "utf8").trim()
    if (mid) profiles.zcode.headers.anthropic["X-Device-Mid"] = mid
  } catch {}
  return profiles
}

const DEFAULTS = {
  profile: "off",
  excludeProviders: ["zcode"],
  providerOverrides: {},
  port: DEFAULT_PORT,
  log: "change", // always | change | off
  profiles: {},
  versions: {}, // hand pins, e.g. {"codex":"0.170.0"} — beat fetched values
  autoVersions: true, // refresh codex/claude-code/aiSdk from npm in the background
  updateEveryHours: 24,
  registry: null, // extra npm registry tried first, e.g. https://registry.npmmirror.com
}

// ---- config -----------------------------------------------------------------

let cache = { mtime: -1, cfg: DEFAULTS }

function normalize(raw) {
  const c = { ...DEFAULTS, ...(raw && typeof raw === "object" ? raw : {}) }
  c.excludeProviders = Array.isArray(c.excludeProviders) ? c.excludeProviders.map(String) : [...DEFAULTS.excludeProviders]
  c.providerOverrides = c.providerOverrides && typeof c.providerOverrides === "object" && !Array.isArray(c.providerOverrides) ? c.providerOverrides : {}
  c.profiles = c.profiles && typeof c.profiles === "object" && !Array.isArray(c.profiles) ? c.profiles : {}
  c.port = Number.isInteger(c.port) && c.port >= 0 && c.port <= 65535 ? c.port : DEFAULT_PORT
  c.log = ["always", "change", "off"].includes(c.log) ? c.log : "change"
  c.profile = typeof c.profile === "string" ? c.profile : "off"
  c.selfcheck = c.selfcheck === true
  c.applied = c.applied && typeof c.applied === "object" && !Array.isArray(c.applied) ? c.applied : {}
  c.versions =
    c.versions && typeof c.versions === "object" && !Array.isArray(c.versions)
      ? Object.fromEntries(Object.entries(c.versions).filter(([, v]) => typeof v === "string"))
      : {}
  c.autoVersions = c.autoVersions !== false
  const hours = Number(c.updateEveryHours)
  c.updateEveryHours = Number.isFinite(hours) && hours > 0 ? hours : 24
  c.registry = typeof c.registry === "string" && /^https?:\/\//.test(c.registry) ? c.registry : null
  return c
}

function loadCfg() {
  let st
  try {
    st = fs.statSync(CONFIG_PATH)
  } catch {
    cache = { mtime: -1, cfg: DEFAULTS }
    return cache.cfg
  }
  if (st.mtimeMs === cache.mtime) return cache.cfg
  try {
    cache = { mtime: st.mtimeMs, cfg: normalize(JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"))) }
  } catch (e) {
    // a broken file must not send garbage headers: act as off until fixed
    cache = { mtime: st.mtimeMs, cfg: normalize({ profile: "off" }) }
    note(`config unreadable (${e?.message ?? e}); acting as off`, "error")
  }
  return cache.cfg
}

function saveCfg(patch) {
  const next = normalize({ ...loadCfg(), ...patch })
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  const tmp = `${CONFIG_PATH}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + "\n")
  fs.renameSync(tmp, CONFIG_PATH)
  cache = { mtime: fs.statSync(CONFIG_PATH).mtimeMs, cfg: next }
  return next
}

// ---- versions -------------------------------------------------------------------

let versionsCache = { mtime: -1, data: null }
const VERSION_RE = /^\d+\.\d+\.\d+/

function loadFetchedVersions() {
  try {
    const st = fs.statSync(VERSIONS_PATH)
    if (st.mtimeMs === versionsCache.mtime) return versionsCache.data
    const d = JSON.parse(fs.readFileSync(VERSIONS_PATH, "utf8"))
    const out = { fetched: Number(d.fetched) || 0, versions: {} }
    for (const [k, v] of Object.entries(d.versions ?? {}))
      if (typeof v === "string" && VERSION_RE.test(v)) out.versions[k] = v
    versionsCache = { mtime: st.mtimeMs, data: out }
    return out
  } catch {
    return { fetched: 0, versions: {} }
  }
}

function saveFetchedVersions(versions) {
  const data = { fetched: Date.now(), versions }
  try {
    fs.mkdirSync(path.dirname(VERSIONS_PATH), { recursive: true })
    const tmp = `${VERSIONS_PATH}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
    fs.renameSync(tmp, VERSIONS_PATH)
    versionsCache = { mtime: fs.statSync(VERSIONS_PATH).mtimeMs, data }
  } catch (e) {
    note(`cannot write ${path.basename(VERSIONS_PATH)}: ${e?.message ?? e}`, "error")
  }
  return data
}

// precedence: a hand pin in the config > the last value fetched from npm > built-in
function versionsOf(cfg) {
  const out = { ...DEFAULT_VERSIONS }
  const fetched = loadFetchedVersions().versions
  for (const k of Object.keys(DEFAULT_VERSIONS)) {
    if (typeof cfg?.versions?.[k] === "string" && VERSION_RE.test(cfg.versions[k])) out[k] = cfg.versions[k]
    else if (typeof fetched[k] === "string") out[k] = fetched[k]
  }
  return out
}

let fetching = false
// Pull the latest npm versions for the clients that publish there. Cached in
// VERSIONS_PATH; on change the native providers are rewritten with the new UA
// right away. Never throws — a failed fetch keeps the last known versions.
async function fetchLatestVersions(force = false) {
  const cfg = loadCfg()
  if (!cfg.autoVersions && !force) return { ok: false, skipped: "autoVersions off" }
  const cache = loadFetchedVersions()
  const everyMs = cfg.updateEveryHours * 3600_000
  if (!force && Date.now() - cache.fetched < everyMs)
    return { ok: true, fresh: true, fetchedAt: cache.fetched, versions: cache.versions }
  if (fetching) return { ok: false, skipped: "a fetch is already running" }
  fetching = true
  try {
    const registries = cfg.registry ? [cfg.registry, ...REGISTRIES] : REGISTRIES
    const got = {}
    for (const [key, pkg] of Object.entries(NPM_PACKAGES)) {
      for (const reg of registries) {
        try {
          const r = await fetch(`${reg}/${pkg}/latest`, { signal: AbortSignal.timeout(8000) })
          if (!r.ok) continue
          const j = await r.json()
          if (typeof j?.version === "string" && VERSION_RE.test(j.version)) {
            got[key] = j.version
            break
          }
        } catch {}
      }
    }
    if (!Object.keys(got).length) return { ok: false, error: "no registry answered" }
    const merged = { ...cache.versions, ...got }
    const changed = Object.keys(merged).filter((k) => merged[k] !== cache.versions[k])
    if (changed.length || !fs.existsSync(VERSIONS_PATH)) saveFetchedVersions(merged)
    if (changed.length) {
      note(`client versions updated from npm: ${changed.map((k) => `${k}→${merged[k]}`).join(", ")}`)
      try {
        providersApply(loadCfg())
      } catch {}
    }
    return { ok: true, fetchedAt: Date.now(), versions: merged, changed }
  } finally {
    fetching = false
  }
}

function versionState(cfg) {
  const inUse = versionsOf(cfg)
  const fetched = loadFetchedVersions()
  const pins = cfg.versions ?? {}
  const values = {}
  for (const k of Object.keys(DEFAULT_VERSIONS)) {
    values[k] = {
      inUse: inUse[k],
      source: typeof pins[k] === "string" ? "pinned" : fetched.versions[k] ? "fetched" : "builtin",
      npm: NPM_PACKAGES[k] ?? null,
      npmLatest: fetched.versions[k] ?? null,
    }
  }
  return {
    autoVersions: cfg.autoVersions,
    updateEveryHours: cfg.updateEveryHours,
    fetchedAt: fetched.fetched || null,
    values,
  }
}

// ---- profile resolution -------------------------------------------------------

function effectiveProfiles(cfg) {
  const out = { ...builtinProfiles(versionsOf(cfg)) }
  for (const [id, p] of Object.entries(cfg.profiles ?? {})) {
    if (!p || typeof p !== "object") continue
    const ok = typeof p.ua === "string" || (p.forms && typeof p.forms === "object")
    if (ok) out[id] = p
  }
  return out
}

function formHeaders(h, protocol) {
  return { ...((h && h.any) ?? {}), ...((h && h[protocol]) ?? {}) }
}

function resolveForm(p, protocol) {
  if (!p) return null
  if (p.forms) {
    const f = p.forms[protocol] ?? p.forms.default
    if (!f) return null
    return { ua: f.ua, headers: formHeaders(f.headers, protocol) }
  }
  return { ua: p.ua, headers: formHeaders(p.headers, protocol) }
}

function protocolOf(msg) {
  const npm = String(msg?.model?.api?.npm ?? msg?.provider?.info?.npm ?? "")
  if (npm.includes("anthropic")) return "anthropic"
  if (npm.includes("openai") || npm.includes("responses")) return "openai"
  return "other"
}

// ---- native providers (providers.json) ---------------------------------------

// Native providers (API-key entries of providers.json, fetched by magpie's
// Go side, not the plugin host) take their headers from the entry's headers
// object, which always wins over the UA magpie would send. The switcher
// writes the resolved profile there on every switch; the app hot-reloads the
// file. Only the keys recorded in cfg.applied are ever removed again, so
// headers the user set themselves survive an "off".
function wireOf(p) {
  if (p.baseAPI === "responses" || typeof p.responses === "string") return "openai"
  if (p.baseAPI === "anthropic" || /anthropic/i.test(String(p.baseURL ?? ""))) return "anthropic"
  return "other"
}

function providersApply(cfg) {
  let raw
  try {
    raw = fs.readFileSync(PROVIDERS_PATH, "utf8")
  } catch {
    return
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    note("providers.json unreadable; native providers left untouched", "error")
    return
  }
  if (!json || !Array.isArray(json.providers)) return
  const profiles = effectiveProfiles(cfg)
  const applied = { ...(cfg.applied ?? {}) }
  let changed = false
  for (const p of json.providers) {
    if (!p || typeof p !== "object" || typeof p.id !== "string") continue
    const name =
      cfg.excludeProviders.includes(p.id) ? "off" : cfg.providerOverrides[p.id] || cfg.profile
    const headers = {}
    if (name && name !== "off") {
      const form = resolveForm(profiles[name], wireOf(p))
      if (form && form.ua) {
        headers["User-Agent"] = form.ua
        for (const [k, v] of Object.entries(form.headers || {})) headers[k] = String(v)
      }
    }
    const merged = { ...(p.headers ?? {}) }
    for (const k of applied[p.id] ?? []) if (!(k in headers)) delete merged[k]
    for (const [k, v] of Object.entries(headers)) merged[k] = v
    const before = JSON.stringify(p.headers ?? {})
    if (Object.keys(merged).length) p.headers = merged
    else delete p.headers
    if (JSON.stringify(p.headers ?? {}) !== before) changed = true
    const keys = Object.keys(headers)
    if (keys.length) applied[p.id] = keys
    else delete applied[p.id]
  }
  if (changed) {
    try {
      const tmp = `${PROVIDERS_PATH}.ua-switcher.tmp`
      fs.writeFileSync(tmp, JSON.stringify(json, null, 2))
      fs.renameSync(tmp, PROVIDERS_PATH)
      note(`rewrote headers of native providers per profile "${cfg.profile}"`)
    } catch (e) {
      note(`cannot write providers.json: ${e?.message ?? e}`, "error")
      return
    }
  }
  if (JSON.stringify(applied) !== JSON.stringify(cfg.applied ?? {})) saveCfg({ applied })
}

// ---- logging ------------------------------------------------------------------

let appLog = null // (message, level) => void via client.app.log RPC; never stdout
const noted = new Set()

function note(message, level = "info", once = true) {
  if (once && noted.has(message)) return
  noted.add(message)
  try {
    if (appLog) appLog(message, level)
    else console.error(`ua-switcher: ${message}`)
  } catch {
    try {
      console.error(`ua-switcher: ${message}`)
    } catch {}
  }
}

// ---- the hook -------------------------------------------------------------------

const seen = new Map() // providerID -> last applied tag, for log:"change"
let lastAppliedMtime = -1 // ua-switcher.json mtime providers were last applied for

async function chatHeaders(msg, out) {
  let cfg
  try {
    cfg = loadCfg()
  } catch {
    return
  }
  // watchdog: when no instance of ours holds the switcher port (a deferred-to
  // sibling died, or the bind kept failing), re-attempt at most once a minute
  if (server === null && Date.now() - lastBindTry > 60000) {
    try {
      bindAttempt()
    } catch {}
  }
  if (cache.mtime !== lastAppliedMtime) {
    lastAppliedMtime = cache.mtime
    try {
      providersApply(cfg)
    } catch {}
  }
  const providerID = String(msg?.message?.model?.providerID ?? msg?.provider?.info?.id ?? "")
  if (providerID && cfg.excludeProviders.includes(providerID)) return
  const wanted = cfg.providerOverrides[providerID] || cfg.profile
  if (!wanted || wanted === "off") {
    if (cfg.log === "always") note(`${providerID || "?"}: off (magpie default UA)`, "info", false)
    return
  }
  const profile = effectiveProfiles(cfg)[wanted]
  if (!profile) {
    note(`unknown profile "${wanted}" — acting as off`, "error")
    return
  }
  const protocol = protocolOf(msg)
  const form = resolveForm(profile, protocol)
  if (!form || !form.ua) return
  out.headers["User-Agent"] = form.ua
  for (const [k, v] of Object.entries(form.headers || {})) out.headers[k] = String(v)
  if (cfg.log !== "off") {
    const tag = `${providerID || "?"} ← ${wanted} [${protocol}]`
    if (cfg.log === "always" || seen.get(providerID) !== tag) {
      seen.set(providerID, tag)
      note(`${tag} ${form.ua}`, "info", false)
    }
  }
}

// ---- the web switcher -------------------------------------------------------------

let server = null // Bun server, or "external" while another healthy instance holds the port
let lastBindTry = 0

// ---- /config validation ----------------------------------------------------------

const ID_RE = /^[A-Za-z0-9._-]{1,40}$/
const HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+.^_|~-]{1,64}$/ // RFC 7230 token, pragmatic

function cleanExcludes(v) {
  if (!Array.isArray(v)) throw new Error("excludeProviders 必须是数组")
  const out = []
  for (const x of v) {
    if (typeof x !== "string" || !ID_RE.test(x)) throw new Error(`无效的 provider id：${JSON.stringify(x)}`)
    if (!out.includes(x)) out.push(x)
  }
  return out
}

function cleanOverrides(v, profiles) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("providerOverrides 必须是对象")
  const out = {}
  for (const [id, prof] of Object.entries(v)) {
    if (!ID_RE.test(id)) throw new Error(`无效的 provider id：${id}`)
    if (prof !== "off" && !profiles[prof]) throw new Error(`providerOverrides.${id} 引用了不存在的档案：${prof}`)
    out[id] = prof
  }
  return out
}

function cleanPins(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("versions 必须是对象")
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_VERSIONS, k)) throw new Error(`未知的版本键：${k}`)
    if (val === "" || val == null) continue // an empty value clears the pin
    if (typeof val !== "string" || !VERSION_RE.test(val)) throw new Error(`versions.${k} 不是合法版本号：${JSON.stringify(val)}`)
    out[k] = val
  }
  return out
}

function cleanHeadersGroup(v, where) {
  const out = {}
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} 必须是对象`)
  for (const [k, val] of Object.entries(v)) {
    if (!HEADER_KEY_RE.test(k)) throw new Error(`${where} 含非法头字段名：${JSON.stringify(k)}`)
    if (typeof val !== "string" || !val.length || val.length > 512) throw new Error(`${where}.${k} 的值必须是 1–512 字符`)
    out[k] = val
  }
  return out
}

function cleanProfileForm(f, where) {
  if (!f || typeof f !== "object") throw new Error(`${where} 必须是对象`)
  const out = {}
  if (f.ua != null) {
    if (typeof f.ua !== "string" || !f.ua.length || f.ua.length > 512) throw new Error(`${where}.ua 必须是 1–512 字符`)
    out.ua = f.ua
  }
  if (f.headers) {
    const g = {}
    for (const proto of ["any", "anthropic", "openai"]) if (f.headers[proto]) g[proto] = cleanHeadersGroup(f.headers[proto], `${where}.headers.${proto}`)
    if (Object.keys(g).length) out.headers = g
  }
  return out
}

function cleanProfiles(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("profiles 必须是对象")
  const out = {}
  for (const [id, p] of Object.entries(v)) {
    if (!ID_RE.test(id)) throw new Error(`无效的档案 id：${JSON.stringify(id)}`)
    if (!p || typeof p !== "object") throw new Error(`档案 ${id} 必须是对象`)
    const one = {}
    if (typeof p.label === "string" && p.label.trim()) one.label = p.label.trim().slice(0, 60)
    if (p.forms) {
      if (typeof p.forms !== "object" || Array.isArray(p.forms)) throw new Error(`档案 ${id} 的 forms 必须是对象`)
      const forms = {}
      for (const [proto, f] of Object.entries(p.forms)) {
        if (!["anthropic", "openai", "default"].includes(proto)) throw new Error(`档案 ${id}.forms 含未知协议：${proto}`)
        forms[proto] = cleanProfileForm(f, `档案 ${id}.forms.${proto}`)
      }
      one.forms = forms
    } else {
      if (typeof p.ua !== "string" || !p.ua.length || p.ua.length > 512) throw new Error(`档案 ${id} 的 ua 必须是 1–512 字符`)
      one.ua = p.ua
      if (p.headers) {
        const g = {}
        for (const proto of ["any", "anthropic", "openai"]) if (p.headers[proto]) g[proto] = cleanHeadersGroup(p.headers[proto], `档案 ${id}.headers.${proto}`)
        if (Object.keys(g).length) one.headers = g
      }
    }
    out[id] = one
  }
  return out
}

// providersForUi lists what the provider sections of the page offer: every
// native entry of providers.json plus the plugin-declared zcode provider.
function providersForUi() {
  const out = [{ id: "zcode", name: "ZCode（插件 provider）", off: false, wire: "anthropic" }]
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf8"))
    for (const p of j.providers ?? []) {
      if (p && typeof p === "object" && typeof p.id === "string" && !out.some((q) => q.id === p.id))
        out.push({ id: p.id, name: String(p.name ?? p.id), off: p.off === true, wire: wireOf(p) })
    }
  } catch {}
  return out
}

function state() {
  const cfg = loadCfg()
  const profiles = effectiveProfiles(cfg)
  return {
    plugin: "ua-switcher",
    profile: cfg.profile,
    excludeProviders: cfg.excludeProviders,
    providerOverrides: cfg.providerOverrides,
    port: server ? server.port : cfg.port,
    configPath: CONFIG_PATH,
    versions: versionState(cfg),
    pins: cfg.versions ?? {},
    providers: providersForUi(),
    customProfiles: Object.fromEntries(
      Object.entries(cfg.profiles).map(([id, p]) => [
        id,
        {
          label: p.label || id,
          ua: typeof p.ua === "string" ? p.ua : "",
          headers: p.headers && typeof p.headers === "object" && !Array.isArray(p.headers) ? p.headers : {},
          forms: p.forms ? true : undefined,
          raw: p, // handed back untouched when the page saves other profiles
        },
      ]),
    ),
    profiles: [
      { id: "off", label: "关闭 · magpie 默认" },
      ...Object.entries(profiles).map(([id, p]) => ({ id, label: p.label || id })),
    ],
  }
}

// The page is a static shell; the script renders everything from /state so
// the server never builds HTML with user data in it.
function page() {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>magpie UA 切换器</title>
<script>try{var v=localStorage.getItem("ua-switcher-font");if(v)document.documentElement.style.setProperty("--fs",Number(v)+"px")}catch(e){}</script>
<style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#111418;color:#e8eaed;font-family:system-ui,"Segoe UI","Microsoft YaHei",sans-serif;font-size:var(--fs,clamp(15px,.7vw + 12.5px,18px));line-height:1.6;display:flex;justify-content:center;padding:28px 16px 48px}
main{width:100%;max-width:720px}
h1{font-size:clamp(19px,1vw + 16px,24px);margin:0}
h2{font-size:1.02em;margin:0 0 10px;color:#c7cbd1}
.sub{color:#9aa0a6;font-size:.8em;margin:2px 0 18px}
.cur{color:#7ab0ff;font-weight:600}
.card{border:1px solid #2b3038;border-radius:12px;padding:14px 16px;margin-top:16px;background:#151920}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(170px,1fr));gap:10px}
button{font:inherit}
button.p{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 14px;border-radius:10px;border:1px solid #2b3038;background:#1a1f26;color:#e8eaed;cursor:pointer;text-align:left;transition:border-color .15s,background .15s}
button.p:hover{border-color:#4a5261}
button.p.on{border-color:#7ab0ff;background:#1d2a3d}
button.p.on::after{content:"当前生效";font-size:.72em;color:#7ab0ff}
button.p span{font-size:.95em}
button.p code{font-size:.72em;color:#9aa0a6}
.in,select,textarea,input[type=text]{width:100%;padding:7px 10px;border-radius:8px;border:1px solid #2b3038;background:#1a1f26;color:#e8eaed;font:inherit;font-size:.9em}
input[type=range]{accent-color:#7ab0ff;width:190px}
input[type=number]{width:86px;padding:7px 10px;border-radius:8px;border:1px solid #2b3038;background:#1a1f26;color:#e8eaed;font:inherit;font-size:.9em;text-align:center}
textarea{min-height:64px;resize:vertical;font-family:ui-monospace,Consolas,monospace;font-size:.82em}
textarea:focus,input:focus,select:focus{outline:none;border-color:#4a5261}
label{display:block;font-size:.78em;color:#9aa0a6;margin:10px 0 3px}
.vrow{display:grid;grid-template-columns:minmax(120px,1fr) 2fr;gap:10px;align-items:center;margin:8px 0}
.vname{font-size:.85em}
.tag{display:inline-block;font-size:.68em;border:1px solid #31415a;border-radius:999px;padding:0 8px;margin-left:6px;color:#9aa0a6;vertical-align:middle}
.tag.pin{color:#ffd479;border-color:#6b5a2b}
.tag.get{color:#7ee2b8;border-color:#2b5a47}
.btn{padding:6px 14px;border-radius:8px;border:1px solid #2b3038;background:#1a1f26;color:#e8eaed;cursor:pointer;font-size:.85em}
.btn:hover{border-color:#4a5261}
.btn.pri{background:#1d2a3d;border-color:#37507a;color:#cfe2ff}
.btn.pri:hover{border-color:#7ab0ff}
.btn.mini{padding:2px 9px;font-size:.75em}
.chips{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0 10px}
.chip{display:inline-flex;align-items:center;gap:6px;background:#1d2a3d;border:1px solid #31415a;border-radius:999px;padding:3px 6px 3px 12px;font-size:.82em}
.chip button{background:none;border:none;color:#9aa0a6;cursor:pointer;font-size:.9em;padding:2px 6px;border-radius:999px}
.chip button:hover{color:#ff8a80;background:#2a1d22}
.exrow{display:grid;grid-template-columns:minmax(110px,1fr) minmax(140px,1.4fr);gap:10px;align-items:center;margin:6px 0;font-size:.85em}
.exrow .off{color:#666}
.exrow code{color:#9aa0a6;font-size:.85em}
.plist{margin:4px 0 10px}
.prow{display:flex;align-items:center;gap:8px;padding:7px 10px;border:1px solid #2b3038;border-radius:8px;margin:6px 0;font-size:.88em}
.prow code{color:#9aa0a6;font-size:.85em;margin-right:auto}
.err{color:#ff8a80;font-size:.82em;min-height:1.2em;margin-top:8px}
#status{position:fixed;right:16px;bottom:14px;background:#1d2a3d;border:1px solid #37507a;color:#cfe2ff;border-radius:10px;padding:8px 14px;font-size:.82em;opacity:0;transition:opacity .25s;pointer-events:none;max-width:70vw}
#status.show{opacity:1}
#status.err{background:#2a1d22;border-color:#6b2b35;color:#ff8a80}
.box{margin-top:16px;padding:12px 14px;border:1px solid #2b3038;border-radius:10px;font-size:.78em;color:#9aa0a6}
.box b{color:#c7cbd1;font-weight:600}
.box code{background:#22272f;padding:1px 6px;border-radius:4px;color:#c7cbd1}
.row{margin-top:8px}
</style></head><body><main>
<h1>magpie UA 切换器</h1>
<div class="sub">切换 magpie 发往上游的 User-Agent，所有改动即时生效，无需重启</div>

<div class="card">
<h2>档案 · 当前 <span class="cur" id="cur"></span></h2>
<div class="grid" id="grid"></div>
</div>

<div class="card">
<h2>客户端版本 <span id="vinfo" style="font-weight:400;font-size:.78em;color:#9aa0a6"></span></h2>
<div id="vrows"></div>
<div style="display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap">
<button class="btn pri" id="vsave">保存版本钉死</button>
<button class="btn" id="vrefresh">检查更新</button>
<span style="font-size:.75em;color:#9aa0a6">留空 = 跟随自动更新；填入版本号 = 钉死该版本</span>
</div>
</div>

<div class="card">
<h2>Provider 设置</h2>
<label>排除的 provider（不改写）</label>
<div class="chips" id="exchips"></div>
<div style="display:flex;gap:8px"><select id="exsel"></select><button class="btn" id="exadd">添加排除</button></div>
<label>按 provider 覆盖（优先于全局档案）</label>
<div id="ovrows"></div>
<button class="btn pri" id="psave" style="margin-top:10px">保存 Provider 设置</button>
</div>

<div class="card">
<h2>自定义档案</h2>
<div class="plist" id="plist"></div>
<div id="pform" hidden>
<label>档案 id（英文、数字、.-_）</label><input type="text" id="pf-id" maxlength="40">
<label>显示名</label><input type="text" id="pf-label" maxlength="60">
<label>User-Agent</label><input type="text" id="pf-ua" maxlength="512">
<label>通用头（所有请求，每行「键: 值」）</label><textarea id="pf-any"></textarea>
<label>anthropic 协议头（每行「键: 值」）</label><textarea id="pf-anthropic"></textarea>
<label>openai / responses 协议头（每行「键: 值」）</label><textarea id="pf-openai"></textarea>
<div style="display:flex;gap:10px;margin-top:10px">
<button class="btn pri" id="pfsave">保存档案</button>
<button class="btn" id="pfcancel">取消</button>
</div>
</div>
<button class="btn" id="pfnew">＋ 新增档案</button>
</div>

<div class="card">
<h2>页面外观</h2>
<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
<input type="range" id="fsr" min="12" max="24" step="1" aria-label="字体大小">
<input type="number" id="fsn" min="12" max="24" step="1" aria-label="字体大小（像素）">
<span id="fslabel" style="font-size:.78em;color:#9aa0a6"></span>
<button class="btn" id="fsreset">重置（自适应）</button>
</div>
</div>

<div class="box">
<div class="row"><b>curl 切换</b>：<code>curl http://127.0.0.1:<span id="port"></span>/set/claude-code</code>（或 codex / pi / zcode / off）</div>
<div class="row"><b>配置文件</b>：<code id="cfgpath"></code>（本页所有改动同样写入此文件，手动编辑亦热生效）</div>
</div>

<div id="status"></div>
<script>
var S=null,excl=[]
function esc(s){return String(s==null?"":s).replace(/[&<>"']/g,function(c){return {"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]})}
function h2t(h){var o=[];for(var k in (h||{}))o.push(k+": "+(h||{})[k]);return o.join("\\n")}
function t2h(t){var o={};String(t||"").split(/\\r?\\n/).forEach(function(line){if(!line.trim())return;var m=line.match(/^\\s*([A-Za-z0-9!#$%&'*+.^_|~-]+)\\s*:\\s*(.*)$/);if(!m)throw new Error("无法解析的头行："+line);o[m[1]]=m[2].trim()});return o}
function flash(msg,isErr){var s=document.getElementById("status");s.textContent=msg;s.className="show"+(isErr?" err":"");clearTimeout(flash.t);flash.t=setTimeout(function(){s.className=""},isErr?5000:2500)}
function post(body){return fetch("/config",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body)}).then(async function(r){var j=await r.json().catch(function(){return {}});if(!r.ok||j.ok===false)throw new Error(j.error||("HTTP "+r.status));return j})}
function when(ms){return ms?new Date(ms).toLocaleString("zh-CN",{hour12:false}):"从未"}

function render(){
document.getElementById("cur").textContent=(S.profiles.find(function(p){return p.id===S.profile})||{}).label||S.profile
document.getElementById("port").textContent=S.port
document.getElementById("cfgpath").textContent=S.configPath
document.getElementById("grid").innerHTML=S.profiles.map(function(p){return '<button class="p'+(p.id===S.profile?" on":"")+'" data-id="'+esc(p.id)+'"><span>'+esc(p.label)+'</span><code>'+esc(p.id)+'</code></button>'}).join("")
var keys=Object.keys(S.versions.values)
document.getElementById("vinfo").textContent=S.versions.autoVersions?("· 自动更新开 · 每 "+S.versions.updateEveryHours+" 小时 · 上次检查 "+when(S.versions.fetchedAt)):"· 自动更新已关"
document.getElementById("vrows").innerHTML=keys.map(function(k){
var v=S.versions.values[k]
var tag=v.source==="pinned"?'<span class="tag pin">钉死</span>':v.source==="fetched"?'<span class="tag get">npm</span>':'<span class="tag">内置</span>'
return '<div class="vrow"><div class="vname"><b>'+esc(k)+'</b>'+tag+(v.npm?'<div style="font-size:.75em;color:#666">'+esc(v.npm)+'</div>':"")+'</div><input type="text" data-vk="'+esc(k)+'" value="'+esc(S.pins[k]||"")+'" placeholder="当前 '+esc(v.inUse)+'"></div>'}).join("")
excl=S.excludeProviders.slice()
renderEx()
var profs=S.profiles
document.getElementById("ovrows").innerHTML=S.providers.map(function(p){
var opts=['<option value="">跟随全局</option>'].concat(profs.map(function(q){return '<option value="'+esc(q.id)+'"'+((S.providerOverrides[p.id]||"")===q.id?" selected":"")+'>'+esc(q.label)+'</option>'})).join("")
return '<div class="exrow"><div>'+esc(p.name)+' '+(p.off?'<span class="off">(已停用)</span>':"")+'<br><code>'+esc(p.id)+' · '+esc(p.wire)+'</code></div><select data-ov="'+esc(p.id)+'">'+opts+'</select></div>'}).join("")
renderPlist()
}
function renderEx(){
var known=S.providers.map(function(p){return p.id})
document.getElementById("exchips").innerHTML=excl.length?excl.map(function(id){return '<span class="chip">'+esc(id)+'<button data-unex="'+esc(id)+'" title="移除">✕</button></span>'}).join(""):'<span style="font-size:.8em;color:#666">无</span>'
document.getElementById("exsel").innerHTML=S.providers.filter(function(p){return excl.indexOf(p.id)<0}).map(function(p){return '<option value="'+esc(p.id)+'">'+esc(p.name)+' ('+esc(p.id)+')</option>'}).join("")||'<option value="">（全部已排除）</option>'
}
function renderPlist(){
var ids=Object.keys(S.customProfiles)
document.getElementById("plist").innerHTML=ids.length?ids.map(function(id){var p=S.customProfiles[id]
return '<div class="prow">📋 '+esc(p.label)+'<code>'+esc(id)+(p.forms?" · 双形态（配置文件编辑）":"")+'</code>'+(p.forms?"":'<button class="btn mini" data-edit="'+esc(id)+'">编辑</button>')+'<button class="btn mini" data-del="'+esc(id)+'">删除</button></div>'}).join(""):'<div style="font-size:.8em;color:#666">暂无，点下方新增</div>'
}
function collectProfiles(extra){
var out={}
for(var id in S.customProfiles){
  if(extra&&extra.del===id)continue
  if(extra&&extra.id===id)continue
  out[id]=S.customProfiles[id].raw}
if(extra&&extra.id&&!extra.del)out[extra.id]=extra.prof
return out
}
async function load(){S=await (await fetch("/state")).json();render()}

document.getElementById("grid").addEventListener("click",function(e){var b=e.target.closest("button.p");if(!b)return
fetch("/set/"+encodeURIComponent(b.dataset.id),{method:"POST"}).then(load).catch(function(){flash("切换失败",true)})})
document.getElementById("vsave").onclick=function(){
var vs={};document.querySelectorAll("[data-vk]").forEach(function(i){vs[i.dataset.vk]=i.value.trim()})
post({versions:vs}).then(function(){flash("版本钉死已保存");load()}).catch(function(e){flash(e.message,true)})}
document.getElementById("vrefresh").onclick=function(){var b=this;b.disabled=true;b.textContent="检查中…"
fetch("/versions/refresh",{method:"POST"}).then(function(r){return r.json()}).then(function(j){b.disabled=false;b.textContent="检查更新"
if(j.ok){flash(j.changed&&j.changed.length?("已更新："+j.changed.join("、")):"已是最新");load()}else flash(j.error||"检查失败",true)}).catch(function(){b.disabled=false;b.textContent="检查更新";flash("检查失败",true)})}
document.getElementById("exadd").onclick=function(){var v=document.getElementById("exsel").value;if(v&&excl.indexOf(v)<0){excl.push(v);renderEx()}}
document.getElementById("exchips").addEventListener("click",function(e){var b=e.target.closest("[data-unex]");if(!b)return;excl=excl.filter(function(x){return x!==b.dataset.unex});renderEx()})
document.getElementById("psave").onclick=function(){
var ov={};document.querySelectorAll("[data-ov]").forEach(function(s){if(s.value)ov[s.dataset.ov]=s.value})
post({excludeProviders:excl,providerOverrides:ov}).then(function(){flash("Provider 设置已保存");load()}).catch(function(e){flash(e.message,true)})}
document.getElementById("pfnew").onclick=function(){openForm()}
document.getElementById("pfcancel").onclick=function(){document.getElementById("pform").hidden=true}
function openForm(id){var f=document.getElementById("pform");f.hidden=false
var p=id?S.customProfiles[id]:null
document.getElementById("pf-id").value=id||"";document.getElementById("pf-id").disabled=!!id
document.getElementById("pf-label").value=p?p.label:""
document.getElementById("pf-ua").value=p?p.ua:""
document.getElementById("pf-any").value=p?h2t(p.headers.any):""
document.getElementById("pf-anthropic").value=p?h2t(p.headers.anthropic):""
document.getElementById("pf-openai").value=p?h2t(p.headers.openai):""
if(p&&p.forms){document.getElementById("pf-ua").value=p.ua||"";document.getElementById("pf-ua").placeholder="该档案为双形态，此处只显示 anthropic 形态的 UA；完整编辑请改配置文件"}
f.scrollIntoView({behavior:"smooth"})}
document.getElementById("pfsave").onclick=function(){
var id=document.getElementById("pf-id").value.trim(),ua=document.getElementById("pf-ua").value
try{var prof={label:document.getElementById("pf-label").value.trim()||id,ua:ua,headers:{}}
var any=t2h(document.getElementById("pf-any").value),an=t2h(document.getElementById("pf-anthropic").value),op=t2h(document.getElementById("pf-openai").value)
if(Object.keys(any).length)prof.headers.any=any
if(Object.keys(an).length)prof.headers.anthropic=an
if(Object.keys(op).length)prof.headers.openai=op
if(!/^[A-Za-z0-9._-]{1,40}$/.test(id))throw new Error("档案 id 只能是英文、数字和 . _ -")
if(!ua)throw new Error("User-Agent 不能为空")
post({profiles:collectProfiles({id:id,prof:prof})}).then(function(){flash("档案已保存");document.getElementById("pform").hidden=true;load()}).catch(function(e){flash(e.message,true)})
}catch(e){flash(e.message,true)}}
document.getElementById("plist").addEventListener("click",function(e){
var d=e.target.closest("[data-del]"),t=e.target.closest("[data-edit]")
if(d){post({profiles:collectProfiles({id:d.dataset.del,del:true})}).then(function(){flash("档案已删除");load()}).catch(function(er){flash(er.message,true)})}
else if(t)openForm(t.dataset.edit)})
var FSK="ua-switcher-font"
function applyFs(v){
var lbl=document.getElementById("fslabel")
if(v){document.documentElement.style.setProperty("--fs",v+"px");lbl.textContent="固定 "+v+"px"}
else{document.documentElement.style.removeProperty("--fs");lbl.textContent="自适应（随窗口）"}}
function initFs(){
var r=document.getElementById("fsr"),n=document.getElementById("fsn")
var v=Number(localStorage.getItem(FSK))
var ok=v>=12&&v<=24
if(ok){r.value=v;n.value=v}else{r.value=16;n.value=""}
applyFs(ok?v:null)
r.oninput=function(){n.value=r.value;applyFs(Number(r.value));localStorage.setItem(FSK,r.value)}
n.onchange=function(){var x=Math.round(Number(n.value));if(!(x>=12&&x<=24))x=16;n.value=x;r.value=x;applyFs(x);localStorage.setItem(FSK,String(x))}
document.getElementById("fsreset").onclick=function(){localStorage.removeItem(FSK);r.value=16;n.value="";applyFs(null)}}
initFs()
load()
</script>
</main></body></html>`
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

async function handle(req) {
  const url = new URL(req.url)
  if (url.pathname === "/" && req.method === "GET") {
    return new Response(page(), { headers: { "content-type": "text/html; charset=utf-8" } })
  }
  if (url.pathname === "/state") return json(state())
  if (url.pathname === "/versions") return json(versionState(loadCfg()))
  if (url.pathname === "/versions/refresh" && req.method === "POST") {
    const r = await fetchLatestVersions(true)
    return json(r, r.ok ? 200 : 502)
  }
  if (url.pathname === "/config" && req.method === "POST") {
    let body
    try {
      body = await req.json()
    } catch {
      return json({ ok: false, error: "请求体不是合法 JSON" }, 400)
    }
    const patch = {}
    try {
      const incomingProfiles = "profiles" in body ? cleanProfiles(body.profiles) : null
      // overrides validate against the built-ins plus the incoming customs together
      const profiles = incomingProfiles
        ? { ...builtinProfiles(versionsOf(loadCfg())), ...incomingProfiles }
        : effectiveProfiles(loadCfg())
      if ("excludeProviders" in body) patch.excludeProviders = cleanExcludes(body.excludeProviders)
      if ("providerOverrides" in body) patch.providerOverrides = cleanOverrides(body.providerOverrides, profiles)
      if ("versions" in body) patch.versions = cleanPins(body.versions)
      if (incomingProfiles) patch.profiles = incomingProfiles
    } catch (e) {
      return json({ ok: false, error: e?.message ?? String(e) }, 400)
    }
    const cfg = saveCfg(patch)
    try {
      providersApply(cfg)
    } catch {}
    return json({ ok: true, state: state() })
  }
  const m = url.pathname.match(/^\/set\/([A-Za-z0-9._-]+)$/)
  if (m && (req.method === "GET" || req.method === "POST")) {
    const name = m[1]
    const ok = name === "off" || !!effectiveProfiles(loadCfg())[name]
    if (!ok) return json({ ok: false, error: `unknown profile: ${name}` }, 400)
    const cfg = saveCfg({ profile: name })
    try {
      providersApply(cfg)
    } catch {}
    return json({ ok: true, profile: cfg.profile })
  }
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 })
  return json({ error: "not found" }, 404)
}

function bindAttempt() {
  lastBindTry = Date.now()
  try {
    server = Bun.serve({ hostname: "127.0.0.1", port: loadCfg().port, fetch: handle })
    globalThis.__uaSwitcherServer = server
    note(`web switcher ready at http://127.0.0.1:${server.port}`)
    return true
  } catch {}
  // the port is held: a healthy sibling instance (e.g. a CLI-spawned host) is
  // fine to defer to; it may outlive its CLI by a long time, and when it dies
  // the hook's watchdog re-binds here.
  try {
    const port = loadCfg().port
    fetch(`http://127.0.0.1:${port}/state`)
      .then((r) => r.json())
      .then((s) => {
        if (s && s.plugin === "ua-switcher" && server === null) {
          server = "external"
          note(`another ua-switcher instance serves port ${port}; deferring to it`)
        }
      })
      .catch(() => {})
  } catch {}
  return false
}

function startServer() {
  try {
    if (globalThis.__uaSwitcherServer) globalThis.__uaSwitcherServer.stop(true)
  } catch {}
  if (bindAttempt()) return
  let tries = 0
  const t = setInterval(() => {
    tries++
    if (tries > 30 || server === "external") {
      clearInterval(t)
      if (server === null) note(`web switcher failed on port ${loadCfg().port}; rewriting still active — switch by editing ${CONFIG_PATH}`, "error")
      return
    }
    if (bindAttempt()) clearInterval(t)
  }, 1000)
  try {
    t.unref?.()
  } catch {}
}

// ---- entry ------------------------------------------------------------------------

export async function UASwitcherPlugin(input) {
  const opts = arguments[1] || {}
  appLog = (message, level) => {
    try {
      input?.client?.app?.log({ level, service: "ua-switcher", message })
    } catch {}
  }
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
      const seed = typeof opts.profile === "string" ? opts.profile : "off"
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(normalize({ profile: seed }), null, 2) + "\n")
    }
  } catch (e) {
    note(`cannot write config: ${e?.message ?? e}`, "error")
  }
  startServer()
  try {
    lastAppliedMtime = cache.mtime
    providersApply(loadCfg())
  } catch {}
  fetchLatestVersions().catch(() => {}) // stale-cache check; rewrites on change
  const hooks = { "chat.headers": chatHeaders }
  // self-check mode: declare a provider whose upstream is the local echo
  // server (echoserver.mjs), so the full gateway → host → chat.headers →
  // upstream chain can be verified against real traffic. Enabled by
  // "selfcheck": true in the config file; needs a plugin reload to apply.
  if (loadCfg().selfcheck) {
    hooks.config = async (cfg) => {
      cfg.provider ??= {}
      cfg.provider["ua-echo"] = {
        name: "UA Echo（自检）",
        npm: "@ai-sdk/anthropic",
        api: "http://127.0.0.1:3427/v1",
        options: { baseURL: "http://127.0.0.1:3427/v1", apiKey: "ua-echo" },
        models: {
          "ua-echo/test": {
            id: "ua-echo/test",
            name: "ua-echo/test",
            reasoning: false,
            tool_call: true,
            attachment: false,
            modalities: { input: ["text"], output: ["text"] },
            limit: { context: 8192, output: 1024 },
            cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
          },
        },
      }
    }
    hooks.auth = {
      provider: "ua-echo",
      async loader() {
        return { baseURL: "http://127.0.0.1:3427/v1", apiKey: "ua-echo" }
      },
    }
  }
  return hooks
}

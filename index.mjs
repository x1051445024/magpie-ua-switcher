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
    profiles: [
      { id: "off", label: "关闭 · magpie 默认" },
      ...Object.entries(profiles).map(([id, p]) => ({ id, label: p.label || id })),
    ],
  }
}

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])

function page() {
  const s = state()
  const buttons = s.profiles
    .map(
      (p) =>
        `<button class="p${p.id === s.profile ? " on" : ""}" data-id="${esc(p.id)}"><span>${esc(p.label)}</span><code>${esc(p.id)}</code></button>`,
    )
    .join("")
  const overrides = Object.entries(s.providerOverrides)
    .map(([k, v]) => `<code>${esc(k)} → ${esc(v)}</code>`)
    .join(" ")
  const v = s.versions?.values ?? {}
  const vrow = (k) => `<code>${esc(k)} ${esc(v[k]?.inUse ?? "?")}${v[k]?.source === "pinned" ? " ⚑" : ""}</code>`
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>magpie UA 切换器</title><style>
:root{color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;background:#111418;color:#e8eaed;font:14px/1.6 system-ui,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;justify-content:center;padding:32px 16px}
main{width:100%;max-width:560px}
h1{font-size:18px;margin:0 0 4px}
.sub{color:#9aa0a6;font-size:12px;margin-bottom:20px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:10px}
button.p{display:flex;flex-direction:column;align-items:flex-start;gap:4px;padding:12px 14px;border-radius:10px;border:1px solid #2b3038;background:#1a1f26;color:#e8eaed;cursor:pointer;text-align:left;transition:border-color .15s,background .15s}
button.p:hover{border-color:#4a5261}
button.p.on{border-color:#7ab0ff;background:#1d2a3d}
button.p.on::after{content:"当前生效";font-size:11px;color:#7ab0ff}
button.p span{font-size:14px}
button.p code{font-size:11px;color:#9aa0a6}
.box{margin-top:20px;padding:12px 14px;border:1px solid #2b3038;border-radius:10px;font-size:12px;color:#9aa0a6}
.box b{color:#c7cbd1;font-weight:600}
.box code{background:#22272f;padding:1px 6px;border-radius:4px;font-size:11px;color:#c7cbd1}
.row{margin-top:8px}
</style></head><body><main>
<h1>magpie UA 切换器</h1>
<div class="sub">切换 magpie 发往上游的 User-Agent，即时生效，无需重启</div>
<div class="grid">${buttons}</div>
<div class="box">
  <div class="row"><b>排除的 provider</b>（不改写）：${s.excludeProviders.map(esc).join("、") || "无"}</div>
  ${overrides ? `<div class="row"><b>按 provider 覆盖</b>：${overrides}</div>` : ""}
  <div class="row"><b>curl 切换</b>：<code>curl http://127.0.0.1:${s.port}/set/claude-code</code>（或 codex / pi / zcode / off）</div>
  <div class="row"><b>客户端版本</b>：${vrow("codex")} ${vrow("claude-code")} ${vrow("pi")} ${vrow("zcode")}${s.versions?.autoVersions ? "" : "（自动更新已关）"} <button id="rv" style="padding:1px 8px;border-radius:6px;border:1px solid #2b3038;background:#1a1f26;color:#e8eaed;cursor:pointer;font-size:11px">检查更新</button></div>
  <div class="row"><b>配置文件</b>：<code>${esc(s.configPath)}</code>（自定义档案、版本钉死、排除列表、端口，热生效）</div>
</div>
<script>
document.querySelectorAll("button.p").forEach(b=>b.addEventListener("click",()=>{
  fetch("/set/"+encodeURIComponent(b.dataset.id),{method:"POST"}).then(()=>location.reload())
}))
document.getElementById("rv")?.addEventListener("click",()=>{
  const b=document.getElementById("rv");b.textContent="更新中…";b.disabled=true
  fetch("/versions/refresh",{method:"POST"}).then(()=>location.reload()).catch(()=>{b.textContent="重试";b.disabled=false})
})
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

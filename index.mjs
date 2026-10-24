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

// Client versions the UA strings name. Bump here when the real clients
// update; a user can also override any of it per-machine through the
// "profiles" field of the config file.
const VERSIONS = {
  codex: "0.153.4",
  "claude-code": "2.1.280",
  pi: "2.1.75", // the claude-cli identity pi presents on Anthropic-style APIs
  zcode: "3.16.3",
  aiSdk: "3.0.81", // the ai-sdk suffix ZCode's UA carries
}

// codex and pi build their UA's OS segment from the machine they run on, so
// the switcher does the same instead of naming one fixed machine. codex is
// Rust and names arches the Rust way (x64 → x86_64).
const OS_TYPE = { Windows_NT: "Windows", Darwin: "macOS", Linux: "Linux" }[os.type()] ?? os.type()
const RUST_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86" }[process.arch] ?? process.arch
const CODEX_OS_SEG = `${OS_TYPE} ${os.release()}; ${RUST_ARCH}`
const TERMINAL = os.platform() === "win32" ? "WindowsTerminal" : "unknown"

// Header sets matching the real clients.
const BUILTIN_PROFILES = {
  codex: {
    label: "Codex CLI",
    ua: `codex_cli_rs/${VERSIONS.codex} (${CODEX_OS_SEG}) ${TERMINAL}`,
    headers: {
      any: { originator: "codex_cli_rs" },
      openai: { "OpenAI-Beta": "responses=experimental" },
    },
  },
  "claude-code": {
    label: "Claude Code",
    ua: `claude-cli/${VERSIONS["claude-code"]} (external, cli)`,
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
    ua: `ZCode/${VERSIONS.zcode} ai-sdk/anthropic/${VERSIONS.aiSdk}`,
    headers: {
      anthropic: {
        "HTTP-Referer": "https://zcode.z.ai",
        "X-ZCode-App-Version": VERSIONS.zcode,
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
  if (mid) BUILTIN_PROFILES.zcode.headers.anthropic["X-Device-Mid"] = mid
} catch {}

const DEFAULTS = {
  profile: "off",
  excludeProviders: ["zcode"],
  providerOverrides: {},
  port: DEFAULT_PORT,
  log: "change", // always | change | off
  profiles: {},
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

// ---- profile resolution -------------------------------------------------------

function effectiveProfiles(cfg) {
  const out = { ...BUILTIN_PROFILES }
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

let server = null

function state() {
  const cfg = loadCfg()
  const profiles = effectiveProfiles(cfg)
  return {
    profile: cfg.profile,
    excludeProviders: cfg.excludeProviders,
    providerOverrides: cfg.providerOverrides,
    port: server ? server.port : cfg.port,
    configPath: CONFIG_PATH,
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
  <div class="row"><b>配置文件</b>：<code>${esc(s.configPath)}</code>（自定义档案、排除列表、端口，热生效）</div>
</div>
<script>
document.querySelectorAll("button.p").forEach(b=>b.addEventListener("click",()=>{
  fetch("/set/"+encodeURIComponent(b.dataset.id),{method:"POST"}).then(()=>location.reload())
}))
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

function startServer() {
  try {
    if (globalThis.__uaSwitcherServer) globalThis.__uaSwitcherServer.stop(true)
  } catch {}
  const port = loadCfg().port
  const bind = () => {
    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle })
    globalThis.__uaSwitcherServer = server
    note(`web switcher ready at http://127.0.0.1:${server.port}`)
    return true
  }
  try {
    bind()
    return
  } catch {}
  // a transient CLI-spawned host (every `magpie plugin …` command runs one)
  // can hold the port for a moment while the resident host reloads — retry
  // briefly. unref'd so a transient host still exits with its CLI instead of
  // being kept alive by this timer alone.
  let tries = 0
  const t = setInterval(() => {
    tries++
    if (tries > 30) {
      clearInterval(t)
      note(`web switcher failed on port ${port}; rewriting still active — switch by editing ${CONFIG_PATH}`, "error")
      return
    }
    try {
      if (bind()) clearInterval(t)
    } catch {}
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

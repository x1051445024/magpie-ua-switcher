// ua-switcher — switch the User-Agent (and companion identity headers) magpie
// sends upstream: Codex CLI / Claude Code / pi / ZCode / custom profiles.
//
// Switching is done from a tiny local web page (default
// http://127.0.0.1:3426), by curl, or by editing ~/.config/magpie/ua-switcher.json
// — all hot, no magpie restart needed. Each switch rewrites the native
// providers' `headers` in magpie's own providers.json, which is what magpie
// sends upstream; the `chat.headers` hook covers the requests magpie's plugin
// host makes itself, and is applied last, over every other header source (SDK
// defaults, auth loader, headers passed in by the main app).
//
// A Claude Code profile also fills in the metadata.user_id a real Claude Code
// sends, since 1.8.0 as the provider's `extraBody` in providers.json: magpie
// merges it in Go as the body goes out (internal/provider/extrabody.go), so no
// request body has to cross into the plugin host for it any more.
//
// Known limits: chat.headers can add and override headers, not remove them;
// the zcode provider's Start-Plan (-Trial) models rebuild their headers
// entirely, so this plugin cannot (and should not) touch those. The user_id
// field follows the provider's wire, so it is written for Messages providers
// only, and magpie applies extraBody to API-key providers (and a ChatGPT
// sign-in), not to another agent's signed-in account.

import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { randomBytes, randomUUID } from "node:crypto"
import { Writable } from "node:stream"
import {
  adoptLegacy,
  besideConfig,
  configPath,
  magpieDir,
  providersPath,
  useMagpieDir,
  versionsPath,
  zcodeMidPath,
} from "./paths.mjs"
import { CLAUDE_CODE_PROFILES, formatUserId, isOurMetadata, peekBaseId, resetUserIdMemo, userId } from "./userid.mjs"

let CONFIG_PATH = configPath()
let PROVIDERS_PATH = providersPath()
let VERSIONS_PATH = versionsPath()
let ZCODE_DEVICE_MID_PATH = zcodeMidPath()

let cache = { mtime: -1, cfg: null }
let versionsCache = { mtime: -1, data: null }
let providersUiCache = { mtime: -1, list: null, error: null } // read-only once cached
let zcodeMidCache = { checkedAt: 0, mid: "" }
let lastAppliedMtime = -1
let lastProvidersMtime = -1
let providerNotification = Promise.resolve()

function refreshPaths() {
  const nextCfg = configPath()
  const nextProv = providersPath()
  const nextVer = versionsPath()
  const nextMid = zcodeMidPath()
  if (nextCfg !== CONFIG_PATH || nextProv !== PROVIDERS_PATH || nextVer !== VERSIONS_PATH || nextMid !== ZCODE_DEVICE_MID_PATH) {
    CONFIG_PATH = nextCfg
    PROVIDERS_PATH = nextProv
    VERSIONS_PATH = nextVer
    ZCODE_DEVICE_MID_PATH = nextMid
    cache = { mtime: -1, cfg: DEFAULTS }
    versionsCache = { mtime: -1, data: null }
    providersUiCache = { mtime: -1, list: null, error: null }
    zcodeMidCache = { checkedAt: 0, mid: "" }
    resetUserIdMemo() // the identity file moved with the config folder
    lastAppliedMtime = -1
    lastProvidersMtime = -1
  }
}

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
  bun: "1.4.4", // the Bun runtime version opencode's binary reports as its UA
  antigravity: "2.26.0", // Antigravity Hub release; also probed from the local install
}

// npm packages behind the auto-updated versions. aiSdk is deliberately not
// here: what a closed client (ZCode) bundles internally is not npm's latest,
// and a version its real UA never carried is worse than a stale one.
const NPM_PACKAGES = {
  codex: "@openai/codex",
  "claude-code": "@anthropic-ai/claude-code",
}
const REGISTRIES = ["https://registry.npmjs.org", "https://registry.npmmirror.com"]

// codex and pi build their UA's OS segment from the machine they run on, so
// the switcher does the same instead of naming one fixed machine. codex is
// Rust and names arches the Rust way (x64 → x86_64).
// opencode sends no User-Agent of its own (the Bun runtime's default rides
// along); its identity is the session header trio below. Persist the ids across
// host reloads so cache notification does not trigger another header rewrite.
function newOpencodeSessionId() {
  try {
    return `ses_${randomBytes(32).toString("hex")}`
  } catch {
    let s = ""
    while (s.length < 64) s += Math.floor(Math.random() * 16).toString(16)
    return `ses_${s}`
  }
}
const OPENCODE_SESSION_ID = newOpencodeSessionId()

// Official codex_cli_rs generates an ephemeral window UUID on start and sends
// companion fingerprint headers (x-codex-window-id, session-id). Strict upstream
// gateways (such as Sub2API with codex_cli_only enabled) check this fingerprint gate.
function newCodexSessionId() {
  try {
    return randomUUID()
  } catch {
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16)
    })
  }
}
const CODEX_SESSION_ID = newCodexSessionId()

// Antigravity Hub build changelists, as published with each release. A version
// missing here omits cl= entirely — claiming another build's CL would be a lie
// the real manifests never tell.
const ANTIGRAVITY_CL = {
  "2.23.0": "998057262",
  "2.23.1": "998881661",
  "2.24.0": "1000335682",
}
// The Hub names its runtime platform the Go way (runtime.GOOS/GOARCH).
const ANTI_OS = { win32: "windows", darwin: "darwin", linux: "linux" }[os.platform()] ?? os.platform()
const ANTI_ARCH = { x64: "amd64", arm64: "arm64", ia32: "386" }[os.arch()] ?? os.arch()
const ANTIGRAVITY_PLATFORM = `os_type=${ANTI_OS}; arch=${ANTI_ARCH}`

const OS_TYPE = { Windows_NT: "Windows", Darwin: "macOS", Linux: "Linux" }[os.type()] ?? os.type()
const RUST_ARCH = { x64: "x86_64", arm64: "aarch64", ia32: "x86" }[process.arch] ?? process.arch
const CODEX_OS_SEG = `${OS_TYPE} ${os.release()}; ${RUST_ARCH}`
const STAINLESS_OS = { win32: "Windows", darwin: "MacOS", linux: "Linux" }[os.platform()] ?? "Linux"
const STAINLESS_ARCH = { x64: "x64", arm64: "arm64", ia32: "x86" }[os.arch()] ?? os.arch()
const TERMINAL =
  process.env.TERM_PROGRAM ||
  (process.env.WT_SESSION ? "WindowsTerminal" : os.platform() === "win32" ? "WindowsTerminal" : "xterm-256color")

function getZcodeDeviceMid() {
  const now = Date.now()
  if (now - zcodeMidCache.checkedAt < 10_000) return zcodeMidCache.mid
  zcodeMidCache.checkedAt = now
  try {
    zcodeMidCache.mid = fs.readFileSync(zcodeMidPath(), "utf8").trim()
  } catch {
    zcodeMidCache.mid = ""
  }
  return zcodeMidCache.mid
}

// Header sets matching the real clients. Built per call from the effective
// versions, so a background version refresh changes the UA without a reload.
function builtinProfiles(V, sessionIds = {}) {
  const profiles = {
    codex: {
      label: "Codex CLI",
      ua: `codex_cli_rs/${V.codex} (${CODEX_OS_SEG}) ${TERMINAL}`,
      headers: {
        any: {
          originator: "codex_cli_rs",
          "x-codex-window-id": sessionIds.codex ?? CODEX_SESSION_ID,
          "session-id": sessionIds.codex ?? CODEX_SESSION_ID,
        },
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
          "X-Stainless-Os": STAINLESS_OS,
          "X-Stainless-Arch": STAINLESS_ARCH,
          "X-Stainless-Runtime": "node",
          "X-Stainless-Runtime-Version": "v22.14.0",
        },
      },
    },
    // pi presents two identities, exactly as the real client does: Claude
    // Code's on Anthropic-style APIs, its own on OpenAI responses endpoints.
    pi: {
      label: "pi（按协议自动）",
      forms: {
        anthropic: {
          ua: `claude-cli/${V.pi}`,
          headers: {
            any: { "x-app": "cli" },
            anthropic: {
              "anthropic-version": "2023-06-01",
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
    opencode: {
      label: "opencode",
      ua: `Bun/${V.bun}`,
      headers: {
        // The real client only injects X-Title/HTTP-Referer/X-Source on a
        // handful of official providers; on custom baseURLs just the session
        // headers ride along. We send all of them so relays can recognize us.
        any: {
          "HTTP-Referer": "https://opencode.ai/",
          "X-Title": "opencode",
          "X-Source": "opencode",
          "x-opencode-session-id": sessionIds.opencode ?? OPENCODE_SESSION_ID,
          "X-Session-Id": sessionIds.opencode ?? OPENCODE_SESSION_ID,
          "x-session-affinity": sessionIds.opencode ?? OPENCODE_SESSION_ID,
        },
      },
    },
    antigravity: {
      label: "Antigravity Hub",
      ua: (() => {
        const cl = ANTIGRAVITY_CL[V.antigravity]
        return `antigravity/hub/${V.antigravity} (aidev_client; ${ANTIGRAVITY_PLATFORM}${cl ? `; cl=${cl}` : ""})`
      })(),
      // The Hub sends no companion headers — its User-Agent alone is the identity.
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
          "X-Platform": `${os.platform()}-${os.arch()}`,
          "X-Os-Category": ANTI_OS,
        },
      },
    },
  }
  // The real device id magpie's zcode-auth uses, when present.
  const mid = getZcodeDeviceMid()
  if (mid) profiles.zcode.headers.anthropic["X-Device-Mid"] = mid
  return profiles
}

const DEFAULTS = {
  profile: "off",
  excludeProviders: ["zcode"],
  providerOverrides: {},
  port: DEFAULT_PORT,
  log: "change",
  profiles: {},
  versions: {},
  selfcheck: false,
  applied: {},
  appliedHeaders: {},
  appliedMeta: {},
  sessionIds: {},
  autoVersions: true,
  updateEveryHours: 24,
  registry: null, // extra npm registry tried first, e.g. https://registry.npmmirror.com
}

// ---- config -----------------------------------------------------------------

let reqNonce = 0

function safeWriteJsonSync(targetPath, dataObj, defaultMode = 0o600) {
  let target = targetPath
  try {
    target = fs.realpathSync(targetPath)
  } catch {}
  let mode = defaultMode
  try {
    const st = fs.statSync(target)
    if (st.mode & 0o777) mode = st.mode & 0o777
  } catch {}

  fs.mkdirSync(path.dirname(target), { recursive: true })
  const tmp = `${target}.${process.pid}.${++reqNonce}.tmp`
  const content = JSON.stringify(dataObj, null, 2) + "\n"
  try {
    fs.writeFileSync(tmp, content, { encoding: "utf8", mode })
    try {
      fs.chmodSync(tmp, mode)
    } catch {}
    for (let i = 0; i < 3; i++) {
      try {
        fs.renameSync(tmp, target)
        return
      } catch (e) {
        if (i === 2 || (e?.code !== "EPERM" && e?.code !== "EACCES" && e?.code !== "EBUSY")) {
          try {
            fs.copyFileSync(tmp, target)
            try { fs.chmodSync(target, mode) } catch {}
            return
          } catch {}
          throw e
        }
      }
    }
  } finally {
    try {
      if (fs.existsSync(tmp)) fs.unlinkSync(tmp)
    } catch {}
  }
}

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
  c.appliedHeaders = c.appliedHeaders && typeof c.appliedHeaders === "object" && !Array.isArray(c.appliedHeaders) ? c.appliedHeaders : {}
  c.appliedMeta =
    c.appliedMeta && typeof c.appliedMeta === "object" && !Array.isArray(c.appliedMeta) ? c.appliedMeta : {}
  const sessionIds = c.sessionIds ?? {}
  c.sessionIds = {}
  if (typeof sessionIds.codex === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionIds.codex)) c.sessionIds.codex = sessionIds.codex
  if (typeof sessionIds.opencode === "string" && /^ses_[0-9a-f]{64}$/.test(sessionIds.opencode)) c.sessionIds.opencode = sessionIds.opencode
  c.versions =
    c.versions && typeof c.versions === "object" && !Array.isArray(c.versions)
      ? Object.fromEntries(Object.entries(c.versions).filter(([, v]) => typeof v === "string"))
      : {}
  c.autoVersions = c.autoVersions !== false
  const hours = Number(c.updateEveryHours)
  c.updateEveryHours = Number.isFinite(hours) && hours > 0 ? hours : 24
  c.registry = typeof c.registry === "string" && /^https?:\/\//.test(c.registry) ? c.registry : null
  // metadata.user_id for Claude Code profiles: written as the provider's
  // extraBody by providersApply, and merged upstream by magpie itself
  c.injectMetadata = c.injectMetadata !== false
  return c
}

function loadCfg() {
  refreshPaths()
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
  safeWriteJsonSync(CONFIG_PATH, next)
  cache = { mtime: fs.statSync(CONFIG_PATH).mtimeMs, cfg: next }
  return next
}

// ---- versions -------------------------------------------------------------------

const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]{1,24})?$/

function loadFetchedVersions() {
  refreshPaths()
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
  refreshPaths()
  const data = { fetched: Date.now(), versions }
  try {
    safeWriteJsonSync(VERSIONS_PATH, data)
    versionsCache = { mtime: fs.statSync(VERSIONS_PATH).mtimeMs, data }
  } catch (e) {
    note(`cannot write ${path.basename(VERSIONS_PATH)}: ${e?.message ?? e}`, "error")
  }
  return data
}

// precedence: a hand pin in the config > the local Antigravity install (only for
// the antigravity key) > the last value fetched from npm > built-in
function versionsOf(cfg) {
  const out = { ...DEFAULT_VERSIONS }
  const fetched = loadFetchedVersions().versions
  const detected = { antigravity: detectAntigravityVersion() }
  for (const k of Object.keys(DEFAULT_VERSIONS)) {
    if (typeof cfg?.versions?.[k] === "string" && VERSION_RE.test(cfg.versions[k])) out[k] = cfg.versions[k]
    else if (typeof detected[k] === "string") out[k] = detected[k]
    else if (typeof fetched[k] === "string") out[k] = fetched[k]
  }
  return out
}

// ---- local Antigravity install ------------------------------------------------

// Antigravity's Hub release lives in the app.asar root package.json
// ("version", e.g. 2.26.0 — the same value the running language server gets as
// --override_ide_version). Reading it keeps the profile's UA in step with a
// client upgrade without any network call. Any failure means "unknown" and the
// built-in / pinned version wins.
export function readAsarPackageVersion(asarPath) {
  let fd
  try {
    fd = fs.openSync(asarPath, "r")
    const hdr = Buffer.alloc(16)
    if (fs.readSync(fd, hdr, 0, 16, 0) !== 16) return null
    const headerSize = hdr.readUInt32LE(4)
    let jsonLen = hdr.readUInt32LE(12)
    let jsonOff = 16
    const sane = (n) => n > 1 && n < 64 * 1024 * 1024
    if (!sane(headerSize)) return null
    if (!sane(jsonLen)) {
      // older asar layout: length sits at offset 8, JSON starts at 12
      jsonLen = hdr.readUInt32LE(8)
      jsonOff = 12
      if (!sane(jsonLen)) return null
    }
    const raw = Buffer.alloc(jsonLen)
    if (fs.readSync(fd, raw, 0, jsonLen, jsonOff) !== jsonLen) return null
    const header = JSON.parse(raw.toString("utf8"))
    const entry = header?.files?.["package.json"]
    const entrySize = Number(entry?.size)
    const entryOffset = Number(entry?.offset)
    if (
      !entry ||
      typeof entry.offset !== "string" ||
      !Number.isFinite(entrySize) ||
      entrySize <= 0 ||
      entrySize > 1024 * 1024 ||
      !Number.isFinite(entryOffset) ||
      entryOffset < 0
    )
      return null
    let base = 8 + headerSize
    if (base % 4) base += 4 - (base % 4)
    const data = Buffer.alloc(entrySize)
    fs.readSync(fd, data, 0, data.length, base + entryOffset)
    const pkg = JSON.parse(data.toString("utf8"))
    if (typeof pkg?.version === "string" && VERSION_RE.test(pkg.version)) return pkg.version
    return null
  } catch {
    return null
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd) } catch {}
  }
}

const ANTIGRAVITY_ASARS = [
  path.join(process.env.LOCALAPPDATA ?? "", "Programs", "Antigravity", "resources", "app.asar"),
  "/Applications/Antigravity.app/Contents/Resources/app.asar",
  "/usr/share/antigravity/resources/app.asar",
  "/opt/antigravity/resources/app.asar",
  path.join(os.homedir(), ".local", "share", "antigravity", "resources", "app.asar"),
]
let detectedCache = { path: null, mtime: -1, version: null }

function detectAntigravityVersion() {
  for (const p of ANTIGRAVITY_ASARS) {
    if (!p) continue
    try {
      const st = fs.statSync(p)
      if (detectedCache.path === p && detectedCache.mtime === st.mtimeMs) return detectedCache.version
      const v = readAsarPackageVersion(p)
      detectedCache = { path: p, mtime: st.mtimeMs, version: v }
      if (v) return v
    } catch {}
  }
  return null
}

// ---- auto-update from npm -------------------------------------------------------

async function fetchLatestVersions(force = false) {
  const cfg = loadCfg()
  if (!cfg.autoVersions && !force) return { ok: false, reason: "disabled" }
  const cache = loadFetchedVersions()
  const everyMs = cfg.updateEveryHours * 3600_000
  if (!force && Date.now() - cache.fetched < everyMs) return { ok: true, cached: true }

  const registries = cfg.registry ? [cfg.registry, ...REGISTRIES] : REGISTRIES
  const got = {}
  for (const [key, pkg] of Object.entries(NPM_PACKAGES)) {
    for (const reg of registries) {
      try {
        const r = await fetch(`${reg}/${pkg}/latest`, { signal: AbortSignal.timeout(8000) })
        if (!r.ok) continue
        const j = await r.json()
        const v = typeof j?.version === "string" ? j.version.trim() : ""
        if (VERSION_RE.test(v)) {
          got[key] = v
          break
        }
      } catch {}
    }
  }

  const merged = { ...cache.versions, ...got }
  saveFetchedVersions(merged)
  const changed = Object.keys(merged).filter((k) => merged[k] !== cache.versions[k])
  if (changed.length) {
    note(`updated client versions from npm: ${changed.map((k) => `${k}=${merged[k]}`).join(", ")}`)
    try {
      providersApply(loadCfg())
    } catch {}
  }
  return { ok: true, fetched: got, changed }
}

function versionState(cfg) {
  const inUse = versionsOf(cfg)
  const fetched = loadFetchedVersions()
  const pins = cfg.versions ?? {}
  const detected = { antigravity: detectAntigravityVersion() }
  const values = {}
  for (const k of Object.keys(DEFAULT_VERSIONS)) {
    let source = "builtin"
    if (typeof pins[k] === "string" && pins[k]) source = "pinned"
    else if (typeof detected[k] === "string" && detected[k]) source = "detected"
    else if (typeof fetched.versions[k] === "string" && fetched.versions[k]) source = "fetched"
    values[k] = {
      inUse: inUse[k],
      source,
      npm: NPM_PACKAGES[k] ?? null,
      default: DEFAULT_VERSIONS[k],
    }
  }
  return {
    autoVersions: cfg.autoVersions,
    updateEveryHours: cfg.updateEveryHours,
    fetchedAt: fetched.fetched,
    values,
  }
}

// ---- profile resolution ---------------------------------------------------------

function effectiveProfiles(cfg) {
  const out = Object.assign(Object.create(null), builtinProfiles(versionsOf(cfg), cfg.sessionIds))
  for (const [id, p] of Object.entries(cfg.profiles ?? {})) {
    if (!p || typeof p !== "object") continue
    const ok = typeof p.ua === "string" || (p.forms && typeof p.forms === "object")
    if (ok) out[id] = p
  }
  return out
}

function wantedProfile(cfg, providerID) {
  return Object.hasOwn(cfg.providerOverrides, providerID) ? cfg.providerOverrides[providerID] : cfg.profile
}

function putHeader(headers, name, value) {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === name.toLowerCase()) delete headers[key]
  }
  headers[name] = value
}

function formHeaders(h, protocol) {
  if (!h || typeof h !== "object") return {}
  const any = h.any && typeof h.any === "object" ? h.any : {}
  const specific =
    protocol === "anthropic"
      ? h.anthropic && typeof h.anthropic === "object"
        ? h.anthropic
        : {}
      : protocol === "openai"
        ? h.openai && typeof h.openai === "object"
          ? h.openai
          : {}
        : {}
  return { ...any, ...specific }
}

function resolveForm(p, protocol) {
  if (!p) return null
  if (p.forms && typeof p.forms === "object") {
    const f = p.forms[protocol] ?? p.forms.default
    if (!f || typeof f !== "object" || typeof f.ua !== "string") return null
    return { ua: f.ua, headers: formHeaders(f.headers, protocol) }
  }
  if (typeof p.ua !== "string") return null
  return { ua: p.ua, headers: formHeaders(p.headers, protocol) }
}

function protocolOf(msg) {
  const npm = String(msg?.model?.api?.npm ?? msg?.provider?.info?.npm ?? "")
  if (npm.includes("anthropic")) return "anthropic"
  if (npm.includes("openai")) return "openai"
  return "other"
}

// providers.json's wire field: "anthropic" for Messages API, "openai" for
// responses API endpoints. This picks the right headers group so anthropic
// headers never leak to OpenAI upstreams and vice versa, even when the same
// headers the user set themselves survive an "off".
//
// One fix, nothing else: what the user declared as the provider's base API
// wins over which endpoint fields happen to be filled in, because magpie's
// editor saves `chat` / `responses` / `anthropic` / `gemini` beside `baseAPI`
// (internal/gui/providers.go:80, :91) and a Messages relay can carry a
// responses URL. Everything else keeps v1.7.0's order exactly: this function
// decides header groups for every profile, so a wider reordering would be a
// silent behavior change for people who never asked for one. `messagesWire`
// below is where the wider Messages question lives.
function wireOf(p) {
  if (!p || typeof p !== "object") return "other"
  if (p.baseAPI === "anthropic") return "anthropic"
  if (p.baseAPI === "responses" || typeof p.responses === "string") return "openai"
  if (/anthropic/i.test(String(p.baseURL ?? ""))) return "anthropic"
  return "other"
}

// Whether the provider can be reached on the Messages wire at all, which is
// what decides whether the user_id is written. Wider than wireOf on purpose:
// a mixed provider's Claude models go to its anthropic endpoint untranslated
// even while its headers follow the responses group, and those are the relays
// that ask for the complete Claude Code identity. A provider whose base API is
// Gemini is left alone: magpie would send a Gemini body, and generateContent's
// Proto3 JSON parser refuses a top-level name it has no field for.
// (There is no `native_endpoints` in providers.json to read — magpie computes
// that per model, internal/provider/native_endpoints.go:11, and only reports
// it in /v1/models.)
function messagesWire(p) {
  if (!p || typeof p !== "object") return false
  if (p.baseAPI === "gemini") return false
  if (wireOf(p) === "anthropic") return true
  return typeof p.anthropic === "string" && p.anthropic.trim() !== ""
}

// The first magpie that reads a provider's extraBody is v0.1.1191
// (internal/provider/extrabody.go, commit 863af7a, 2026-10-11, #1604). Below
// it the field is ignored, so the user_id simply never arrives — no error, no
// log line. magpie records the version it last ran in `last-version`, written
// by the desktop GUI's what's-new pass (internal/gui/whatsnew.go:127); a
// headless `magpie web` in Docker has no such file, and a plugin is never
// handed magpie's version in its input (internal/plugin/host.js:1211). So this
// warns only on positive evidence of an old version and says nothing when the
// file is absent or unreadable — a guess about the version is not a warning.
const MIN_EXTRABODY_PATCH = 1191

// The 1.7.0 way to ask for tool-schema diagnostics was `"diagnose": true` in
// ua-switcher.json, read by the gateway hook. That hook is gone and the
// middleware that replaced it can only see the plugin's options, so the old
// key now means nothing on its own. note() speaks once per message, so this is
// safe to ask from the load path and from /state alike.
function warnLegacyDiagnose(cfg) {
  if (cfg && cfg.diagnose === true) {
    note(
      'diagnose is set in ua-switcher.json, which 1.8.0 no longer reads: the middleware takes it from the plugin options instead — run magpie plugin options ua-switcher {"diagnose":true}, or drop the key here to silence this.',
      "warn",
    )
  }
}

function magpieVersionHint() {
  let raw
  try {
    raw = fs.readFileSync(path.join(magpieDir(), "last-version"), "utf8").trim()
  } catch {
    return null
  }
  const m = /^0\.1\.(\d+)$/.exec(raw)
  if (!m) return null
  return { version: raw, tooOld: Number(m[1]) < MIN_EXTRABODY_PATCH }
}

function providersApply(cfg) {
  refreshPaths()
  let raw
  try {
    raw = fs.readFileSync(PROVIDERS_PATH, "utf8")
  } catch (e) {
    const error = e?.code === "ENOENT" ? "not found" : String(e?.message ?? e)
    note(`cannot read ${PROVIDERS_PATH}: ${error}`, "warn")
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
  const applied = Object.assign(Object.create(null), cfg.applied)
  const appliedHeaders = Object.assign(Object.create(null), cfg.appliedHeaders)
  const appliedMeta = Object.assign(Object.create(null), cfg.appliedMeta)
  let idForThisPass = null // userId() reads and may write a file: once a pass
  let baseForThisPass = null // peekBaseId() reads it the same way
  let changed = false
  let metaChanged = false
  for (const p of json.providers) {
    if (!p || typeof p !== "object" || typeof p.id !== "string") continue
    const name =
      cfg.excludeProviders.includes(p.id) ? "off" : wantedProfile(cfg, p.id)
    const headers = {}
    if (name && name !== "off") {
      const form = resolveForm(profiles[name], wireOf(p))
      if (form && form.ua) {
        putHeader(headers, "User-Agent", form.ua)
        for (const [k, v] of Object.entries(form.headers || {})) putHeader(headers, k, String(v))
      }
    }
    const merged = { ...(p.headers ?? {}) }
    const previous = Object.hasOwn(appliedHeaders, p.id) ? appliedHeaders[p.id] : {}
    for (const [name, record] of Object.entries(previous ?? {})) {
      const aliases = Object.keys(merged).filter((k) => k.toLowerCase() === name.toLowerCase())
      // Remove owned aliases; a later manual alias wins over the saved original.
      const owned = aliases.filter((k) => merged[k] === record.value)
      if (owned.length) {
        for (const k of owned) delete merged[k]
        if (owned.length === aliases.length) Object.assign(merged, record.before)
      }
    }
    // Legacy keys are already ours, so never capture their values as originals.
    // Untracked aliases remain available to the new restoration ledger.
    const legacy = Object.hasOwn(applied, p.id) && Array.isArray(applied[p.id]) ? applied[p.id] : []
    if (!Object.hasOwn(appliedHeaders, p.id)) {
      for (const k of legacy) delete merged[k]
    }
    const written = {}
    for (const [k, v] of Object.entries(headers)) {
      const before = Object.fromEntries(Object.entries(merged).filter(([n]) => n.toLowerCase() === k.toLowerCase()))
      putHeader(merged, k, v)
      written[k] = { value: v, before }
    }
    const before = JSON.stringify(p.headers ?? {})
    if (Object.keys(merged).length) p.headers = merged
    else delete p.headers
    if (JSON.stringify(p.headers ?? {}) !== before) changed = true
    const keys = Object.keys(headers)
    if (keys.length) applied[p.id] = keys
    else delete applied[p.id]
    if (keys.length) appliedHeaders[p.id] = written
    else delete appliedHeaders[p.id]

    // Claude Code's metadata.user_id, as the provider's extraBody: magpie
    // merges those into the body as it goes out (internal/provider/
    // extrabody.go), in Go, so no request body has to cross into the plugin
    // host for it — which is what a gateway hook (magpie.hooks) made it do,
    // for every request, until 1.8.0. Two of magpie's own rules carry the
    // old hook's scope: a field the body already has is kept, so a client's
    // own user_id is never overwritten, and the field is written only for a
    // provider that answers the Messages wire — extraBody is flat, so on a
    // mixed provider a Chat or Responses request carries it as well, which is
    // why a provider with no anthropic endpoint at all is left alone.
    const mine = Array.isArray(appliedMeta[p.id]) ? appliedMeta[p.id] : []
    const wantsMeta = cfg.injectMetadata !== false && CLAUDE_CODE_PROFILES.has(name) && messagesWire(p)
    const eb = p.extraBody && typeof p.extraBody === "object" && !Array.isArray(p.extraBody) ? { ...p.extraBody } : {}
    const wrote = []
    const claimed = mine.includes("metadata")
    if (baseForThisPass === null) baseForThisPass = peekBaseId()
    const ours = isOurMetadata(eb.metadata, { baseId: baseForThisPass, recordedInLedger: claimed })
    if (wantsMeta) {
      if (wireOf(p) !== "anthropic") {
        note(`${p.id}: it answers the Messages wire beside another; magpie sends extraBody on every wire, so a Chat or Responses request to it carries metadata too`)
      }
      if (!("metadata" in eb) || ours) {
        if (idForThisPass === null) idForThisPass = userId()
        const ua = Object.entries(headers).find(([k]) => k.toLowerCase() === "user-agent")?.[1]
        eb.metadata = { user_id: formatUserId(idForThisPass, ua) }
        wrote.push("metadata")
      } else {
        note(`${p.id}: its extraBody metadata is not what this plugin writes; left as set`, "warn")
      }
    } else if ("metadata" in eb && ours) {
      delete eb.metadata
    }
    const beforeMeta = JSON.stringify(p.extraBody ?? {})
    if (Object.keys(eb).length) p.extraBody = eb
    else delete p.extraBody
    if (JSON.stringify(p.extraBody ?? {}) !== beforeMeta) {
      changed = true
      metaChanged = true
    }
    if (wrote.length) appliedMeta[p.id] = wrote
    else delete appliedMeta[p.id]
  }
  if (changed) {
    try {
      safeWriteJsonSync(PROVIDERS_PATH, json)
      try {
        lastProvidersMtime = fs.statSync(PROVIDERS_PATH).mtimeMs
      } catch {}
      note(`rewrote headers of native providers per profile "${cfg.profile}"`)
      if (metaChanged) {
        note("wrote Claude Code's metadata.user_id as extraBody for the Messages providers")
        const hint = magpieVersionHint()
        if (hint?.tooOld) {
          note(
            `magpie ${hint.version} is older than v0.1.${MIN_EXTRABODY_PATCH}, which is the first that reads a provider's extraBody: the user_id is written but magpie will ignore it. Update magpie.`,
            "warn",
          )
        }
      }
    } catch (e) {
      note(`cannot write providers.json: ${e?.message ?? e}`, "error")
      return
    }
  }
  const ledgersChanged =
    JSON.stringify(applied) !== JSON.stringify(cfg.applied ?? {}) ||
    JSON.stringify(appliedHeaders) !== JSON.stringify(cfg.appliedHeaders ?? {}) ||
    JSON.stringify(appliedMeta) !== JSON.stringify(cfg.appliedMeta ?? {})
  if (ledgersChanged) saveCfg({ applied, appliedHeaders, appliedMeta })
  try {
    lastAppliedMtime = cache.mtime
    lastProvidersMtime = fs.statSync(PROVIDERS_PATH).mtimeMs
  } catch {}
  if (changed) notifyProvidersChanged()
  return changed
}

function notifyProvidersChanged() {
  // The Magpie host's existing auth event invalidates provider/catalog caches
  // without modifying sign-ins or retiring the process serving this request.
  if (/[\\/]plugin-host[\\/]host-[0-9a-f]{12}\.js$/i.test(process.argv[1] ?? "")) {
    try {
      // Bypass the redirected method while retaining the stdout stream's queue,
      // so this frame cannot split an RPC line waiting for its remaining bytes.
      providerNotification = new Promise((resolve, reject) => {
        Writable.prototype.write.call(process.stdout, JSON.stringify({ event: "auth" }) + "\n", (error) => {
          if (error) reject(error)
          else resolve()
        })
      }).then(() => new Promise((resolve) => setTimeout(resolve, 25))).catch((error) => {
        note(`cannot notify Magpie of provider changes: ${error.message}`, "warn")
        notifyProviderListChanged()
      })
      return
    } catch (e) {
      note(`cannot notify Magpie of provider changes: ${e.message}`, "warn")
    }
  }
  notifyProviderListChanged()
}

function notifyProviderListChanged() {
  // Magpie invalidates its provider cache when the plugin-list stamp changes.
  const listPath = path.join(path.dirname(PROVIDERS_PATH), "plugins.json")
  try {
    const stat = fs.statSync(listPath)
    if (!stat.isFile()) return
    const stamp = new Date(Math.max(Date.now(), Math.ceil(stat.mtimeMs) + 1))
    fs.utimesSync(listPath, stat.atime, stamp)
  } catch (e) {
    if (e?.code !== "ENOENT") note(`cannot notify Magpie of provider changes: ${e?.message ?? e}`, "warn")
  }
}

// ---- logging ------------------------------------------------------------------

let appLog = null // (message, level) => void via client.app.log RPC; never stdout
const noted = new Set()
const recentEvents = [] // { ts: string, level: string, text: string }

function pushEvent(text, level = "info") {
  recentEvents.push({ ts: new Date().toISOString(), level, text: String(text) })
  if (recentEvents.length > 60) recentEvents.shift()
}

function note(message, level = "info", once = true) {
  if (once) {
    if (noted.has(message)) return
    if (noted.size > 500) noted.clear()
    noted.add(message)
  }
  pushEvent(message, level)
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

async function chatHeaders(msg, out) {
  try {
    if (!out || typeof out !== "object") return
    if (!out.headers || typeof out.headers !== "object") out.headers = {}
    const cfg = loadCfg()
    // watchdog: when no instance of ours holds the switcher port (a deferred-to
    // sibling died, or the bind kept failing), re-attempt at most once every 30s
    if ((server === null || server === "external") && Date.now() - lastBindTry > 30000) {
      try {
        bindAttempt(false)
      } catch {}
    }
    let provMtime = lastProvidersMtime
    try {
      provMtime = fs.statSync(PROVIDERS_PATH).mtimeMs
    } catch {}
    if (cache.mtime !== lastAppliedMtime || provMtime !== lastProvidersMtime) {
      lastAppliedMtime = cache.mtime
      lastProvidersMtime = provMtime
      try {
        providersApply(cfg)
      } catch {}
    }
    const providerID = String(msg?.message?.model?.providerID ?? msg?.provider?.info?.id ?? "")
    if (providerID && cfg.excludeProviders.includes(providerID)) return
    const wanted = wantedProfile(cfg, providerID)
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
    putHeader(out.headers, "User-Agent", form.ua)
    for (const [k, v] of Object.entries(form.headers || {})) putHeader(out.headers, k, String(v))
    if (cfg.log !== "off") {
      const tag = `${providerID || "?"} ← ${wanted} [${protocol}]`
      if (cfg.log === "always" || seen.get(providerID) !== tag) {
        if (seen.size > 200) seen.clear()
        seen.set(providerID, tag)
        note(`${tag} ${form.ua}`, "info", false)
      }
    }
  } catch {}
}

// ---- the web switcher -------------------------------------------------------------

let server = null // Bun server, or "external" while another healthy instance holds the port
let lastBindTry = 0

// ---- /config validation ----------------------------------------------------------

const ID_RE = /^[A-Za-z0-9_.-]{1,40}$/
const HEADER_KEY_RE = /^[A-Za-z0-9!#$%&'*+._\x60|^~-]{1,64}$/ // RFC 7230 token, pragmatic (no range between . and ^)
const CTL_RE = /[\r\n\0]/
const FORBIDDEN_HEADERS = new Set([
  "host",
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "content-length",
  "transfer-encoding",
  "connection",
])
const RESERVED_PROFILE_IDS = new Set(["off", "__proto__", "constructor", "prototype"])

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
    if (typeof prof !== "string" || (prof !== "off" && !Object.hasOwn(profiles, prof))) throw new Error(`providerOverrides.${id} 引用了不存在的档案：${prof}`)
    Object.defineProperty(out, id, { value: prof, enumerable: true, configurable: true, writable: true })
  }
  return out
}

function cleanPins(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("versions 必须是对象")
  const out = {}
  for (const [k, val] of Object.entries(v)) {
    if (!Object.prototype.hasOwnProperty.call(DEFAULT_VERSIONS, k)) throw new Error(`未知的版本键：${k}`)
    if (val === "" || val == null) continue // an empty value clears the pin
    if (typeof val !== "string" || !VERSION_RE.test(val) || val.length > 32)
      throw new Error(`versions.${k} 不是合法版本号：${JSON.stringify(val)}`)
    out[k] = val
  }
  return out
}

function cleanHeadersGroup(v, where) {
  const out = {}
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${where} 必须是对象`)
  for (const [k, val] of Object.entries(v)) {
    if (!HEADER_KEY_RE.test(k) || k.includes(":")) throw new Error(`${where} 含非法头字段名：${JSON.stringify(k)}`)
    if (FORBIDDEN_HEADERS.has(k.toLowerCase())) throw new Error(`${where} 禁止覆盖受保护的请求头：${k}`)
    if (typeof val !== "string" || !val.length || val.length > 512 || CTL_RE.test(val))
      throw new Error(`${where}.${k} 的值必须是 1–512 字符且不含控制字符`)
    out[k] = val
  }
  return out
}

function cleanProfileForm(f, where) {
  if (!f || typeof f !== "object") throw new Error(`${where} 必须是对象`)
  const out = {}
  if (f.ua != null) {
    if (typeof f.ua !== "string" || !f.ua.length || f.ua.length > 512 || CTL_RE.test(f.ua)) throw new Error(`${where}.ua 必须是 1–512 字符且不含控制字符`)
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
    if (RESERVED_PROFILE_IDS.has(id.toLowerCase())) throw new Error(`档案 ID "${id}" 为系统保留名称，不可自定义`)
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
      if (typeof p.ua !== "string" || !p.ua.length || p.ua.length > 512 || CTL_RE.test(p.ua)) throw new Error(`档案 ${id} 的 ua 必须是 1–512 字符且不含控制字符`)
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
  refreshPaths()
  // The page polls /state every 3s and this was the only part of that call that
  // re-read a file every time; the config, the npm cache and the ASAR probe all
  // key off mtime already. Treat providers.json the same way.
  let st = null
  try {
    st = fs.statSync(PROVIDERS_PATH)
  } catch {}
  if (st && st.mtimeMs === providersUiCache.mtime && providersUiCache.list) {
    return { list: providersUiCache.list, error: providersUiCache.error }
  }
  const out = [{ id: "zcode", name: "ZCode（插件 provider）", off: false, wire: "anthropic" }]
  let error = null
  try {
    const j = JSON.parse(fs.readFileSync(PROVIDERS_PATH, "utf8"))
    for (const p of j.providers ?? []) {
      if (p && typeof p === "object" && typeof p.id === "string" && !out.some((q) => q.id === p.id))
        out.push({ id: p.id, name: String(p.name ?? p.id), off: p.off === true, wire: wireOf(p) })
    }
  } catch (e) {
    error = e?.code === "ENOENT" ? "not found" : String(e?.message ?? e)
    note(`cannot read ${PROVIDERS_PATH}: ${error}`, "warn")
  }
  // a file we could not stat is not cached: the next call tries again
  providersUiCache = st ? { mtime: st.mtimeMs, list: out, error } : { mtime: -1, list: null, error: null }
  return { list: out, error }
}

function state() {
  const cfg = loadCfg()
  const profiles = effectiveProfiles(cfg)
  const resolvedProfiles = {}
  for (const [id, p] of Object.entries(profiles)) {
    const anthro = resolveForm(p, "anthropic")
    const oai = resolveForm(p, "openai")
    const def = resolveForm(p, "other")
    resolvedProfiles[id] = {
      ua: anthro?.ua || oai?.ua || def?.ua || "",
      isDual: Boolean(p.forms),
      headers: {
        any: (p.headers && p.headers.any) || (p.forms && p.forms.default && p.forms.default.headers && p.forms.default.headers.any) || {},
        anthropic: anthro?.headers || {},
        openai: oai?.headers || {},
      },
    }
  }
  const prov = providersForUi()
  warnLegacyDiagnose(cfg)
  // what the user_id now rides: magpie's extraBody on these providers, per
  // the last apply. The id itself is a device fingerprint and stays out of
  // /state — the file beside the config holds it.
  const metaProviders = Object.entries(cfg.appliedMeta ?? {})
    .filter(([, keys]) => Array.isArray(keys) && keys.includes("metadata"))
    .map(([id]) => id)
    .sort()
  return {
    plugin: "ua-switcher",
    version: "1.8.8",
    profile: cfg.profile,
    excludeProviders: cfg.excludeProviders,
    providerOverrides: cfg.providerOverrides,
    injectMetadata: cfg.injectMetadata !== false,
    metadata: {
      via: "extraBody",
      profiles: [...CLAUDE_CODE_PROFILES],
      wires: ["anthropic"],
      providers: metaProviders,
      minMagpieVersion: `0.1.${MIN_EXTRABODY_PATCH}`,
      magpieVersion: magpieVersionHint()?.version ?? null,
    },
    autoVersions: cfg.autoVersions !== false,
    port: server && typeof server === "object" ? server.port : cfg.port,
    configPath: CONFIG_PATH,
    providersPath: PROVIDERS_PATH,
    providers: prov.list,
    providersError: prov.error,
    versions: versionState(cfg),
    pins: cfg.versions ?? {},
    resolvedProfiles,
    events: recentEvents.slice().reverse(),
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

const UI_HTML_PATH = path.join(
  import.meta.dir || path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")),
  "ui.html"
)
let uiHtmlCache = { mtime: -1, html: "" }

function page() {
  try {
    const st = fs.statSync(UI_HTML_PATH)
    if (st.mtimeMs === uiHtmlCache.mtime && uiHtmlCache.html) return uiHtmlCache.html
    const html = fs.readFileSync(UI_HTML_PATH, "utf8")
    uiHtmlCache = { mtime: st.mtimeMs, html }
    return html
  } catch (e) {
    return `<!doctype html><html><meta charset="utf-8"><body style="background:#09090b;color:#f4f4f5;font-family:sans-serif;padding:24px"><h1>magpie UA 切换器</h1><p>无法加载 ui.html: ${String(e?.message ?? e)}</p></body></html>`
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2) + "\n", {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  })
}

function isSameOriginRequest(req, url) {
  const host = (req.headers.get("host") || "").split(":")[0].toLowerCase()
  if (host && host !== "127.0.0.1" && host !== "localhost") return false
  const secSite = (req.headers.get("sec-fetch-site") || "").toLowerCase()
  if (secSite && secSite !== "same-origin" && secSite !== "none") return false
  const origin = req.headers.get("origin")
  if (origin) {
    try {
      const origHost = new URL(origin).hostname.toLowerCase()
      if (origHost !== "127.0.0.1" && origHost !== "localhost") return false
    } catch {
      return false
    }
  }
  return true
}

async function handle(req) {
  const url = new URL(req.url)
  if (!isSameOriginRequest(req, url)) {
    return json({ ok: false, error: "forbidden cross-origin or invalid host request" }, 403)
  }
  if (url.pathname === "/" && req.method === "GET") {
    return new Response(page(), {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "X-Frame-Options": "DENY",
        "Content-Security-Policy":
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      },
    })
  }
  if (url.pathname === "/state") return json(state())
  if (url.pathname === "/versions") return json(versionState(loadCfg()))
  if ((url.pathname === "/versions/refresh" || url.pathname === "/fetch-versions") && req.method === "POST") {
    const r = await fetchLatestVersions(true)
    return json(r, r.ok ? 200 : 502)
  }
  if (url.pathname === "/config" && req.method === "POST") {
    const ct = req.headers.get("content-type") || ""
    if (!ct.toLowerCase().includes("application/json")) {
      return json({ ok: false, error: "Content-Type must be application/json" }, 415)
    }
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
      if ("injectMetadata" in body) {
        if (typeof body.injectMetadata !== "boolean") throw new Error("injectMetadata 必须是布尔值")
        patch.injectMetadata = body.injectMetadata
      }
      if ("autoVersions" in body) {
        if (typeof body.autoVersions !== "boolean") throw new Error("autoVersions 必须是布尔值")
        patch.autoVersions = body.autoVersions
      }
      if (incomingProfiles) patch.profiles = incomingProfiles
    } catch (e) {
      return json({ ok: false, error: e?.message ?? String(e) }, 400)
    }
    const cfg = saveCfg(patch)
    try {
      providersApply(cfg)
      await providerNotification
    } catch {}
    return json({ ok: true, state: state() })
  }
  const m = url.pathname.match(/^\/set\/([A-Za-z0-9._-]+)$/)
  if (m && (req.method === "GET" || req.method === "POST")) {
    const name = m[1]
    const ok = name === "off" || Object.hasOwn(effectiveProfiles(loadCfg()), name)
    if (!ok) return json({ ok: false, error: `unknown profile: ${name}` }, 400)
    const cfg = saveCfg({ profile: name })
    try {
      providersApply(cfg)
      await providerNotification
    } catch {}
    return json({ ok: true, profile: cfg.profile })
  }
  if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 })
  return json({ error: "not found" }, 404)
}

let bindRetryTimers = []

function clearBindRetries() {
  while (bindRetryTimers.length) clearTimeout(bindRetryTimers.pop())
}

function scheduleStartupBindRetries() {
  clearBindRetries()
  for (const delay of [300, 800, 2000, 5000]) {
    const t = setTimeout(() => {
      if (server === "external" || server === null) {
        try { bindAttempt(false) } catch {}
      }
    }, delay)
    t.unref?.()
    bindRetryTimers.push(t)
  }
}

function bindAttempt(scheduleRetries = true) {
  lastBindTry = Date.now()
  const cfg = loadCfg()
  if (server && typeof server === "object") return true
  try {
    server = Bun.serve({
      port: cfg.port,
      hostname: "127.0.0.1",
      fetch: handle,
    })
    globalThis.__uaSwitcherServer = server
    clearBindRetries()
    note(`web switcher ready at http://127.0.0.1:${server.port}`)
    return true
  } catch (e) {
    const isAddrInUse = e?.code === "EADDRINUSE" || /EADDRINUSE|address already in use|Failed to listen/i.test(e?.message ?? "")
    if (isAddrInUse) {
      server = "external"
      if (scheduleRetries) scheduleStartupBindRetries()
    } else {
      note(`cannot bind web UI port ${cfg.port}: ${e?.message ?? e}`, "error")
    }
    return false
  }
}

function startServer() {
  try {
    if (globalThis.__uaSwitcherServer) globalThis.__uaSwitcherServer.stop(true)
  } catch {}
  bindAttempt(true)
}

// ---- entry ------------------------------------------------------------------------

export async function UASwitcherPlugin(input) {
  const opts = arguments[1] || {}
  const client = input?.client ?? input
  if (client?.app?.log) {
    appLog = (message, level) => {
      try {
        client.app.log({ level: level || "info", service: "ua-switcher", message: `ua-switcher: ${message}` })
      } catch {}
    }
  }
  if (useMagpieDir(input?.directory)) {
    refreshPaths()
  } else {
    refreshPaths()
  }
  if (!process.env.UA_SWITCHER_CONFIG) {
    const from =
      adoptLegacy(CONFIG_PATH) ||
      adoptLegacy(VERSIONS_PATH) ||
      adoptLegacy(besideConfig("-userid.json"))
    if (from) note(`adopted existing config from ${from} into ${magpieDir()}`)
  }
  try {
    if (!fs.existsSync(CONFIG_PATH)) {
      fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
      const seed = typeof opts.profile === "string" ? opts.profile : "off"
      safeWriteJsonSync(CONFIG_PATH, normalize({ profile: seed }))
    }
    const cfg = loadCfg()
    if (!cfg.sessionIds?.codex || !cfg.sessionIds?.opencode) {
      JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8")) // Preserve an unreadable config rather than overwrite it.
      saveCfg({ sessionIds: { codex: cfg.sessionIds?.codex ?? CODEX_SESSION_ID, opencode: cfg.sessionIds?.opencode ?? OPENCODE_SESSION_ID } })
    }
  } catch (e) {
    note(`cannot write config: ${e?.message ?? e}`, "error")
  }
  try {
    lastAppliedMtime = cache.mtime
    providersApply(loadCfg())
  } catch {}
  // 1.7.0 read `diagnose` from this file, through the gateway hook. The hook is
  // gone and the middleware cannot read files, so the switch now lives in the
  // plugin's options; say so once instead of letting the old setting go quiet.
  warnLegacyDiagnose(loadCfg())
  startServer()
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

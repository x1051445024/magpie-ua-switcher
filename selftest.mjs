// Unit tests for ua-switcher. Run with magpie's bundled Bun:
//   "C:\Users\Lenovo\.cache\magpie\bun\1.4.2\magpie-bun.exe" selftest.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const cfgPath = path.join(os.tmpdir(), `ua-switcher-selftest-${process.pid}.json`)
const provPath = path.join(os.tmpdir(), `ua-switcher-prov-${process.pid}.json`)
process.env.UA_SWITCHER_CONFIG = cfgPath
process.env.UA_SWITCHER_PROVIDERS = provPath
fs.writeFileSync(cfgPath, JSON.stringify({ profile: "off", port: 0, autoVersions: false }))
fs.writeFileSync(
  provPath,
  JSON.stringify({
    providers: [
      { id: "p-responses", key: "sk-x", responses: "http://x/v1", baseAPI: "responses", headers: { "X-Keep": "mine" } },
      { id: "p-anthropic", key: "sk-y", baseURL: "https://relay.example/anthropic" },
      { id: "zcode", key: "sk-z" },
    ],
  }),
)
const prov = () => JSON.parse(fs.readFileSync(provPath, "utf8")).providers

const { UASwitcherPlugin } = await import("./index.mjs")
const logs = []
const hooks = await UASwitcherPlugin({ client: { app: { log: async (o) => logs.push(o.message) } }, directory: os.homedir() }, {})
const chatHeaders = hooks["chat.headers"]

let failures = 0
function eq(name, got, want) {
  const g = JSON.stringify(got)
  const w = JSON.stringify(want)
  if (g === w) console.error(`ok   ${name}`)
  else {
    failures++
    console.error(`FAIL ${name}\n  got  ${g}\n  want ${w}`)
  }
}

function msg(provider, npm) {
  return { message: { model: { providerID: provider, modelID: "m" } }, model: { api: { npm } } }
}
async function apply(provider, npm) {
  const out = { headers: {} }
  await chatHeaders(msg(provider, npm), out)
  return out.headers
}

eq("hook registered", typeof chatHeaders, "function")
eq("off leaves headers untouched", await apply("any", "@ai-sdk/anthropic"), {})

const port = globalThis.__uaSwitcherServer?.port
if (!port) throw new Error("test server not running")
const base = `http://127.0.0.1:${port}`
eq("state endpoint", (await (await fetch(base + "/state")).json()).profile, "off")
eq("set via http", (await (await fetch(base + "/set/codex", { method: "POST" })).json()).profile, "codex")

// codex × protocols
let h = await apply("any", "@ai-sdk/anthropic")
eq("codex ua shape", /^codex_cli_rs\/0\.164\.0 \(.+; .+\) /.test(h["User-Agent"] ?? ""), true)
eq("codex originator", h["originator"], "codex_cli_rs")
eq("codex anthropic has no OpenAI-Beta", "OpenAI-Beta" in h, false)
h = await apply("any", "@ai-sdk/openai-responses")
eq("codex openai OpenAI-Beta", h["OpenAI-Beta"], "responses=experimental")

// claude-code
await fetch(base + "/set/claude-code", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("claude-code ua", h["User-Agent"], "claude-cli/2.1.310 (external, cli)")
eq("claude-code x-app", h["X-App"], "cli")
eq("claude-code beta prefix", String(h["anthropic-beta"]).startsWith("claude-code-20250219"), true)
eq("claude-code stainless", h["X-Stainless-Lang"], "js")
h = await apply("any", "@ai-sdk/openai")
eq("claude-code openai keeps neutral X-App", h["X-App"], "cli")
eq("claude-code openai no anthropic headers", "anthropic-beta" in h, false)

// pi dual form
await fetch(base + "/set/pi", { method: "POST" })
eq("pi anthropic ua", (await apply("any", "@ai-sdk/anthropic"))["User-Agent"], "claude-cli/2.1.75")
h = await apply("any", "@ai-sdk/openai")
eq("pi openai ua shape", /^pi \(.+; .+\)$/.test(h["User-Agent"] ?? ""), true)
eq("pi openai originator", h["originator"], "pi")

// zcode profile & default exclusion
await fetch(base + "/set/zcode", { method: "POST" })
eq("zcode provider excluded by default", await apply("zcode", "@ai-sdk/anthropic"), {})
h = await apply("other", "@ai-sdk/anthropic")
eq("zcode profile ua", h["User-Agent"], "ZCode/3.16.3 ai-sdk/anthropic/3.0.81")
eq("zcode profile referer", h["HTTP-Referer"], "https://zcode.z.ai")

// provider overrides + hot file edit
const cfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
cfg.providerOverrides = { newapi: "codex" }
fs.writeFileSync(cfgPath, JSON.stringify(cfg))
h = await apply("newapi", "@ai-sdk/anthropic")
eq("override newapi→codex", String(h["User-Agent"]).startsWith("codex_cli_rs/"), true)
eq("other provider keeps global", String((await apply("other", "@ai-sdk/anthropic"))["User-Agent"]).startsWith("ZCode/"), true)

// custom profile from config
cfg.profiles = { "my-relay": { label: "My Relay", ua: "MyAgent/1.0", headers: { any: { "X-Tag": "hi" } } } }
fs.writeFileSync(cfgPath, JSON.stringify(cfg))
await fetch(base + "/set/my-relay", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("custom ua", h["User-Agent"], "MyAgent/1.0")
eq("custom header", h["X-Tag"], "hi")

// version pinning beats built-ins; /versions exposes what is in use
await fetch(base + "/set/codex", { method: "POST" })
const cfgV = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
cfgV.versions = { codex: "9.9.9" }
fs.writeFileSync(cfgPath, JSON.stringify(cfgV))
h = await apply("any", "@ai-sdk/anthropic")
eq("pinned codex version wins", String(h["User-Agent"]).startsWith("codex_cli_rs/9.9.9 ("), true)
let vs = await (await fetch(base + "/versions")).json()
eq("versions endpoint inUse", vs.values.codex.inUse, "9.9.9")
eq("versions endpoint source", vs.values.codex.source, "pinned")
eq("versions endpoint npm mapping", vs.values.codex.npm, "@openai/codex")
eq("versions endpoint zcode has no npm", vs.values.zcode.npm, null)
delete cfgV.versions
fs.writeFileSync(cfgPath, JSON.stringify(cfgV))
h = await apply("any", "@ai-sdk/anthropic")
eq("unpinned falls back to builtin", String(h["User-Agent"]).startsWith("codex_cli_rs/0.164.0 ("), true)
vs = await (await fetch(base + "/versions")).json()
eq("fallback source is builtin", vs.values.codex.source, "builtin")

// rejects unknown profiles; page renders
eq("unknown profile rejected", (await fetch(base + "/set/nope", { method: "POST" })).status, 400)
eq("page renders", (await (await fetch(base + "/")).text()).includes("magpie UA"), true)
eq("logs flow through client.app.log", logs.length > 0, true)

// native providers (providers.json headers) — codex
await fetch(base + "/set/codex", { method: "POST" })
let ps = Object.fromEntries(prov().map((p) => [p.id, p]))
eq("native responses UA", String(ps["p-responses"].headers["User-Agent"]).startsWith("codex_cli_rs/0.164.0 ("), true)
eq("native responses originator+beta", [ps["p-responses"].headers["originator"], ps["p-responses"].headers["OpenAI-Beta"]], ["codex_cli_rs", "responses=experimental"])
eq("native keeps user's own header", ps["p-responses"].headers["X-Keep"], "mine")
eq("native anthropic no OpenAI-Beta", "OpenAI-Beta" in (ps["p-anthropic"].headers ?? {}), false)
eq("native anthropic UA", ps["p-anthropic"].headers["User-Agent"].startsWith("codex_cli_rs/"), true)
eq("excluded native provider untouched", "headers" in ps["zcode"], false)
eq("applied map persisted", Object.keys(JSON.parse(fs.readFileSync(cfgPath, "utf8")).applied ?? {}).sort(), ["p-anthropic", "p-responses"])

// native providers — back to off removes exactly our keys
await fetch(base + "/set/off", { method: "POST" })
ps = Object.fromEntries(prov().map((p) => [p.id, p]))
eq("off removes our UA", "User-Agent" in (ps["p-responses"].headers ?? {}), false)
eq("off keeps user's header", ps["p-responses"].headers["X-Keep"], "mine")
eq("off drops empty headers field", "headers" in ps["p-anthropic"], false)
eq("applied map cleared", Object.keys(JSON.parse(fs.readFileSync(cfgPath, "utf8")).applied ?? {}), [])

// /config endpoint: pins, exclusions, overrides, custom profiles
async function postCfg(body) {
  const res = await fetch(base + "/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { status: res.status, j: await res.json().catch(() => ({})) }
}
eq("state lists providers", (await (await fetch(base + "/state")).json()).providers.map((p) => p.id), ["zcode", "p-responses", "p-anthropic"])
let rc = await postCfg({ versions: { codex: "8.8.8" } })
eq("config saves pins", rc.j.ok, true)
await fetch(base + "/set/codex", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("config pin wins", String(h["User-Agent"]).startsWith("codex_cli_rs/8.8.8 ("), true)
rc = await postCfg({ versions: { codex: "" } })
eq("config clears pins", rc.j.state.versions.values.codex.source, "builtin")

eq("bad id rejected", (await postCfg({ profiles: { "bad id!": { ua: "x/1" } } })).status, 400)
eq("bad pin rejected", (await postCfg({ versions: { codex: "not-a-version!" } })).status, 400)
eq("unknown version key rejected", (await postCfg({ versions: { nope: "1.2.3" } })).status, 400)
eq("bad header key rejected", (await postCfg({ profiles: { ok1: { ua: "x/1", headers: { any: { "bad key": "v" } } } } })).status, 400)
eq("override unknown profile rejected", (await postCfg({ providerOverrides: { newapi: "nope" } })).status, 400)
eq("bad excludes rejected", (await postCfg({ excludeProviders: ["x", 5] })).status, 400)

rc = await postCfg({ profiles: { mycli: { label: "MyCli", ua: "MyCli/2.0", headers: { any: { "X-T": "1" } } } } })
eq("config saves custom profile", rc.j.ok, true)
await fetch(base + "/set/mycli", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("custom via config ua", h["User-Agent"], "MyCli/2.0")
eq("custom via config header", h["X-T"], "1")
ps = Object.fromEntries(prov().map((p) => [p.id, p]))
eq("native rewritten per custom", ps["p-responses"].headers["User-Agent"], "MyCli/2.0")

rc = await postCfg({ excludeProviders: ["zcode", "other"], providerOverrides: {} })
eq("config saves excludes", rc.j.state.excludeProviders, ["zcode", "other"])
eq("excluded other untouched", await apply("other", "@ai-sdk/anthropic"), {})
rc = await postCfg({ excludeProviders: ["zcode"] })
eq("config restores excludes", rc.j.state.excludeProviders, ["zcode"])
await fetch(base + "/set/off", { method: "POST" })
rc = await postCfg({ profiles: {} })
eq("config deletes custom profiles", rc.j.state.customProfiles, {})

// opencode profile: Bun runtime UA + opencode identity/session headers
await fetch(base + "/set/opencode", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("opencode ua", h["User-Agent"], "Bun/1.4.4")
eq("opencode referer", h["HTTP-Referer"], "https://opencode.ai/")
eq("opencode x-title", h["X-Title"], "opencode")
eq("opencode x-source", h["X-Source"], "opencode")
const sid = h["x-opencode-session-id"]
eq("opencode session id shape", /^ses_[0-9a-f]{64}$/.test(sid ?? ""), true)
eq("opencode session id shared", [h["X-Session-Id"], h["x-session-affinity"]], [sid, sid])
h = await apply("any", "@ai-sdk/openai")
eq("opencode session id stable across requests", h["x-opencode-session-id"], sid)
rc = await postCfg({ versions: { bun: "9.9.9" } })
eq("opencode bun pin accepted", rc.j.ok, true)
h = await apply("any", "@ai-sdk/anthropic")
eq("opencode pinned bun ua", h["User-Agent"], "Bun/9.9.9")
rc = await postCfg({ versions: { bun: "" } })
eq("opencode bun pin cleared", rc.j.ok, true)

// antigravity profile: Hub UA only, cl= only for known builds
await fetch(base + "/set/antigravity", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("antigravity ua shape", /^antigravity\/hub\/2\.26\.0 \(aidev_client; os_type=\w+; arch=\w+\)$/.test(h["User-Agent"] ?? ""), true)
eq("antigravity sends no extra headers", Object.keys(h), ["User-Agent"])
rc = await postCfg({ versions: { antigravity: "2.24.0" } })
eq("antigravity pin accepted", rc.j.ok, true)
h = await apply("any", "@ai-sdk/openai")
eq("antigravity known cl", String(h["User-Agent"]).includes("; cl=1000335682)"), true)
rc = await postCfg({ versions: { antigravity: "" } })
eq("antigravity pin cleared", rc.j.ok, true)

console.error(failures ? `\n${failures} FAILURES` : "\nall tests passed")
process.exit(failures ? 1 : 0)

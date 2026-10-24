// Unit tests for ua-switcher. Run with magpie's bundled Bun:
//   "C:\Users\Lenovo\.cache\magpie\bun\1.4.2\magpie-bun.exe" selftest.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const cfgPath = path.join(os.tmpdir(), `ua-switcher-selftest-${process.pid}.json`)
const provPath = path.join(os.tmpdir(), `ua-switcher-prov-${process.pid}.json`)
process.env.UA_SWITCHER_CONFIG = cfgPath
process.env.UA_SWITCHER_PROVIDERS = provPath
fs.writeFileSync(cfgPath, JSON.stringify({ profile: "off", port: 0 }))
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
eq("codex ua shape", /^codex_cli_rs\/0\.153\.4 \(.+; .+\) /.test(h["User-Agent"] ?? ""), true)
eq("codex originator", h["originator"], "codex_cli_rs")
eq("codex anthropic has no OpenAI-Beta", "OpenAI-Beta" in h, false)
h = await apply("any", "@ai-sdk/openai-responses")
eq("codex openai OpenAI-Beta", h["OpenAI-Beta"], "responses=experimental")

// claude-code
await fetch(base + "/set/claude-code", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("claude-code ua", h["User-Agent"], "claude-cli/2.1.280 (external, cli)")
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

// rejects unknown profiles; page renders
eq("unknown profile rejected", (await fetch(base + "/set/nope", { method: "POST" })).status, 400)
eq("page renders", (await (await fetch(base + "/")).text()).includes("magpie UA"), true)
eq("logs flow through client.app.log", logs.length > 0, true)

// native providers (providers.json headers) — codex
await fetch(base + "/set/codex", { method: "POST" })
let ps = Object.fromEntries(prov().map((p) => [p.id, p]))
eq("native responses UA", String(ps["p-responses"].headers["User-Agent"]).startsWith("codex_cli_rs/0.153.4 ("), true)
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

console.error(failures ? `\n${failures} FAILURES` : "\nall tests passed")
process.exit(failures ? 1 : 0)

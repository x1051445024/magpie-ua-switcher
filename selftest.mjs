// Unit tests for ua-switcher. Run with magpie's bundled Bun:
//   "C:\Users\Lenovo\.cache\magpie\bun\1.4.2\magpie-bun.exe" selftest.mjs
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"

const taskTestRoot = fs.mkdtempSync(path.join(os.tmpdir(), "ua-switcher-selftest-"))
const cfgPath = path.join(taskTestRoot, "ua-switcher.json")
const provPath = path.join(taskTestRoot, "providers.json")
const pluginListPath = path.join(taskTestRoot, "plugins.json")
const pluginListContents = JSON.stringify({ plugins: [] })
fs.writeFileSync(pluginListPath, pluginListContents)
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
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
let h = await apply("any", "@ai-sdk/anthropic")
eq("codex ua shape", /^codex_cli_rs\/0\.164\.0 \(.+; .+\) /.test(h["User-Agent"] ?? ""), true)
eq("codex originator", h["originator"], "codex_cli_rs")
eq("codex x-codex-window-id shape", UUID_RE.test(h["x-codex-window-id"] ?? ""), true)
eq("codex session-id shape", UUID_RE.test(h["session-id"] ?? ""), true)
eq("codex anthropic has no OpenAI-Beta", "OpenAI-Beta" in h, false)
h = await apply("any", "@ai-sdk/openai-responses")
eq("codex openai OpenAI-Beta", h["OpenAI-Beta"], "responses=experimental")
const mixedHookHeaders = { headers: { "user-agent": "old/1", ORIGINATOR: "old", "X-Keep": "mine" } }
await chatHeaders(msg("any", "@ai-sdk/openai"), mixedHookHeaders)
eq("hook has one UA regardless of case", Object.keys(mixedHookHeaders.headers).filter((k) => k.toLowerCase() === "user-agent"), ["User-Agent"])
eq("hook has one originator regardless of case", Object.keys(mixedHookHeaders.headers).filter((k) => k.toLowerCase() === "originator"), ["originator"])
eq("hook preserves unrelated header", mixedHookHeaders.headers["X-Keep"], "mine")
eq("prototype-named provider uses the global profile", String((await apply("constructor", "@ai-sdk/openai"))["User-Agent"]).startsWith("codex_cli_rs/"), true)

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
// Keep the current ownership ledger when changing a user setting.
const cfgUnpinned = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
delete cfgUnpinned.versions
fs.writeFileSync(cfgPath, JSON.stringify(cfgUnpinned))
h = await apply("any", "@ai-sdk/anthropic")
eq("unpinned falls back to builtin", String(h["User-Agent"]).startsWith("codex_cli_rs/0.164.0 ("), true)
vs = await (await fetch(base + "/versions")).json()
eq("fallback source is builtin", vs.values.codex.source, "builtin")

// rejects unknown profiles; page renders
eq("unknown profile rejected", (await fetch(base + "/set/nope", { method: "POST" })).status, 400)
const pageResp = await fetch(base + "/")
eq("page renders", (await pageResp.text()).includes("magpie UA"), true)
eq("csp includes img-src data:", (pageResp.headers.get("content-security-policy") || "").includes("img-src 'self' data:"), true)
const stInit = await (await fetch(base + "/state")).json()
eq("state has resolvedProfiles", typeof stInit.resolvedProfiles?.["claude-code"]?.ua, "string")
eq("state has events array", Array.isArray(stInit.events), true)
eq("logs flow through client.app.log", logs.length > 0, true)

// native providers (providers.json headers) — codex
if (process.platform !== "win32") fs.chmodSync(provPath, 0o600)
await fetch(base + "/set/off", { method: "POST" })
const beforeNativeSwitch = fs.statSync(pluginListPath).mtimeMs
await fetch(base + "/set/codex", { method: "POST" })
eq("native header changes notify Magpie", fs.statSync(pluginListPath).mtimeMs > beforeNativeSwitch, true)
eq("notification preserves plugin list contents", fs.readFileSync(pluginListPath, "utf8"), pluginListContents)
const afterNativeSwitch = fs.statSync(pluginListPath).mtimeMs
await fetch(base + "/set/codex", { method: "POST" })
eq("unchanged native headers do not reload plugins", fs.statSync(pluginListPath).mtimeMs, afterNativeSwitch)
let ps = Object.fromEntries(prov().map((p) => [p.id, p]))
if (process.platform !== "win32") eq("native rewrite keeps providers.json 0600", (fs.statSync(provPath).mode & 0o777).toString(8), "600")
eq("native rewrite leaves no temp file", fs.existsSync(provPath + ".ua-switcher.tmp"), false)
eq("native responses UA", String(ps["p-responses"].headers["User-Agent"]).startsWith("codex_cli_rs/0.164.0 ("), true)
eq("native responses originator+beta", [ps["p-responses"].headers["originator"], ps["p-responses"].headers["OpenAI-Beta"]], ["codex_cli_rs", "responses=experimental"])
eq("native responses x-codex-window-id", UUID_RE.test(ps["p-responses"].headers["x-codex-window-id"] ?? ""), true)
eq("native responses session-id", UUID_RE.test(ps["p-responses"].headers["session-id"] ?? ""), true)
eq("native keeps user's own header", ps["p-responses"].headers["X-Keep"], "mine")
eq("native anthropic no OpenAI-Beta", "OpenAI-Beta" in (ps["p-anthropic"].headers ?? {}), false)
eq("native anthropic UA", ps["p-anthropic"].headers["User-Agent"].startsWith("codex_cli_rs/"), true)
eq("excluded native provider untouched", "headers" in ps["zcode"], false)
eq("applied map persisted", Object.keys(JSON.parse(fs.readFileSync(cfgPath, "utf8")).applied ?? {}).sort(), ["p-anthropic", "p-responses"])

const beforeHostReload = fs.readFileSync(provPath, "utf8")
const beforeHostReloadStamp = fs.statSync(pluginListPath).mtimeMs
const reloadHost = () => spawnSync(process.execPath, ["--eval", `const { UASwitcherPlugin } = await import(${JSON.stringify(new URL("./index.mjs", import.meta.url).href)}); await UASwitcherPlugin({}, {}); process.exit(0)`], { encoding: "utf8", timeout: 10000 })
const reloadedHost = reloadHost()
eq("fresh plugin host starts successfully", reloadedHost.status, 0)
eq("host reload keeps native session headers stable", fs.readFileSync(provPath, "utf8"), beforeHostReload)
eq("host reload does not notify another reload", fs.statSync(pluginListPath).mtimeMs, beforeHostReloadStamp)
await fetch(base + "/set/opencode", { method: "POST" })
const beforeOpencodeReload = fs.readFileSync(provPath, "utf8")
const beforeOpencodeReloadStamp = fs.statSync(pluginListPath).mtimeMs
eq("fresh opencode host starts successfully", reloadHost().status, 0)
eq("opencode host reload keeps session headers stable", fs.readFileSync(provPath, "utf8"), beforeOpencodeReload)
eq("opencode host reload does not notify another reload", fs.statSync(pluginListPath).mtimeMs, beforeOpencodeReloadStamp)
await fetch(base + "/set/codex", { method: "POST" })

const fakeHostDir = path.join(taskTestRoot, "plugin-host")
fs.mkdirSync(fakeHostDir)
const fakeHostFile = path.join(fakeHostDir, "host-0123456789ab.js")
fs.writeFileSync(fakeHostFile, `
delete process.env.MAGPIE_ADDR;
process.stdout.write = process.stderr.write.bind(process.stderr);
const { UASwitcherPlugin } = await import(${JSON.stringify(new URL("./index.mjs", import.meta.url).href)});
await UASwitcherPlugin({}, {});
const hostBase = "http://127.0.0.1:" + globalThis.__uaSwitcherServer.port;
const realTimeout = globalThis.setTimeout;
let releaseNotification;
globalThis.setTimeout = (callback, delay, ...args) => {
  if (delay === 25) {
    releaseNotification = () => callback(...args);
    return realTimeout(() => {}, 0);
  }
  return realTimeout(callback, delay, ...args);
};
const firstSwitch = fetch(hostBase + "/set/off", { method: "POST" });
for (let attempt = 0; !releaseNotification && attempt < 100; attempt++) {
  await new Promise(resolve => realTimeout(resolve, 5));
}
if (!releaseNotification) process.exit(2);
let repeatedSwitchFinished = false;
let unchangedConfigFinished = false;
const repeatedSwitch = fetch(hostBase + "/set/off", { method: "POST" }).then(() => { repeatedSwitchFinished = true; });
const unchangedConfig = fetch(hostBase + "/config", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }).then(() => { unchangedConfigFinished = true; });
await new Promise(resolve => realTimeout(resolve, 50));
console.error("pending-identical-switch=" + !repeatedSwitchFinished);
console.error("pending-unchanged-config=" + !unchangedConfigFinished);
releaseNotification();
await Promise.all([firstSwitch, repeatedSwitch, unchangedConfig]);
process.exit(0);
`)
const beforeNativeEventStamp = fs.statSync(pluginListPath).mtimeMs
const nativeEventHost = spawnSync(process.execPath, [fakeHostFile], { encoding: "utf8", timeout: 10000 })
eq("native host exits successfully after configuration change", nativeEventHost.status, 0)
eq("native host emits its cache invalidation event", nativeEventHost.stdout.trim(), JSON.stringify({ event: "auth" }))
eq("native event does not restart the plugin host", fs.statSync(pluginListPath).mtimeMs, beforeNativeEventStamp)
eq("identical switch waits for pending notification", nativeEventHost.stderr.includes("pending-identical-switch=true"), true)
eq("unchanged config waits for pending notification", nativeEventHost.stderr.includes("pending-unchanged-config=true"), true)
await fetch(base + "/set/codex", { method: "POST" })

// A large RPC line can have bytes pending when a switch sends its notification.
fs.writeFileSync(fakeHostFile, `
import fs from "node:fs";
import { Writable } from "node:stream";
const { UASwitcherPlugin } = await import(${JSON.stringify(new URL("./index.mjs", import.meta.url).href)});
await UASwitcherPlugin({}, {});
process.stdout._write = (data, encoding, callback) => {
  const bytes = Buffer.from(data);
  fs.writeSync(1, bytes.subarray(0, 4096));
  setTimeout(() => { fs.writeSync(1, bytes.subarray(4096)); callback(); }, 50);
};
const rpcWrite = Writable.prototype.write.bind(process.stdout);
process.stdout.write = process.stderr.write.bind(process.stderr);
const writes = [1, 2].map(id => new Promise((resolve, reject) => {
  rpcWrite(JSON.stringify({ id, event: "chunk", data: "A".repeat(87384) }) + String.fromCharCode(10), error => error ? reject(error) : resolve());
}));
await Promise.all([...writes, fetch("http://127.0.0.1:" + globalThis.__uaSwitcherServer.port + "/set/off", { method: "POST" })]);
process.exit(0);
`)
const fragmentedHost = spawnSync(process.execPath, [fakeHostFile], { encoding: "utf8", timeout: 10000 })
let fragmentedFrames = []
let fragmentParseError = false
try { fragmentedFrames = fragmentedHost.stdout.trim().split("\n").map(line => JSON.parse(line)) } catch { fragmentParseError = true }
eq("fragmented RPC host completes the switch", fragmentedHost.status, 0)
eq("cache notification does not split a pending RPC frame", fragmentParseError, false)
eq("pending RPC chunk frames are retained", fragmentedFrames.filter(frame => frame.event === "chunk").length, 2)
eq("pending RPC payload bytes are retained", fragmentedFrames.filter(frame => frame.event === "chunk").every(frame => frame.data === "A".repeat(87384)), true)
eq("fragmented RPC stream contains the notification", fragmentedFrames.filter(frame => frame.event === "auth"), [{ event: "auth" }])
await fetch(base + "/set/codex", { method: "POST" })

// native providers — back to off removes exactly our keys
const beforeNativeOff = fs.statSync(pluginListPath).mtimeMs
await fetch(base + "/set/off", { method: "POST" })
eq("off notifies Magpie to stop using cached headers", fs.statSync(pluginListPath).mtimeMs > beforeNativeOff, true)
ps = Object.fromEntries(prov().map((p) => [p.id, p]))
eq("off removes our UA", "User-Agent" in (ps["p-responses"].headers ?? {}), false)
eq("off keeps user's header", ps["p-responses"].headers["X-Keep"], "mine")
eq("off drops empty headers field", "headers" in ps["p-anthropic"], false)
eq("applied map cleared", Object.keys(JSON.parse(fs.readFileSync(cfgPath, "utf8")).applied ?? {}), [])

// Same-name headers are restored, and a user's later edits are not deleted.
const originalHeaderProviders = JSON.parse(fs.readFileSync(provPath, "utf8"))
const userHeaderProviders = structuredClone(originalHeaderProviders)
userHeaderProviders.providers[0].headers = { "X-Keep": "mine", "user-agent": "my-client/1", ORIGINATOR: "my-client" }
fs.writeFileSync(provPath, JSON.stringify(userHeaderProviders))
await fetch(base + "/set/codex", { method: "POST" })
ps = Object.fromEntries(prov().map((p) => [p.id, p]))
eq("native has one UA regardless of case", Object.keys(ps["p-responses"].headers).filter((k) => k.toLowerCase() === "user-agent"), ["User-Agent"])
eq("native has one originator regardless of case", Object.keys(ps["p-responses"].headers).filter((k) => k.toLowerCase() === "originator"), ["originator"])
await fetch(base + "/set/pi", { method: "POST" })
await fetch(base + "/set/off", { method: "POST" })
eq("off restores headers from before the first profile", prov()[0].headers, userHeaderProviders.providers[0].headers)
await fetch(base + "/set/codex", { method: "POST" })
const userEditedHeaders = JSON.parse(fs.readFileSync(provPath, "utf8"))
userEditedHeaders.providers[0].headers["User-Agent"] = "manually-edited/2"
fs.writeFileSync(provPath, JSON.stringify(userEditedHeaders))
await fetch(base + "/set/off", { method: "POST" })
eq("off preserves a later user edit to managed UA", prov()[0].headers["User-Agent"], "manually-edited/2")
eq("off does not reintroduce an old case alias over a user edit", "user-agent" in prov()[0].headers, false)
for (const nextProfile of ["off", "pi"]) {
  await fetch(base + "/set/codex", { method: "POST" })
  const userAddedAlias = JSON.parse(fs.readFileSync(provPath, "utf8"))
  userAddedAlias.providers[0].headers["user-agent"] = "manual-alias/3"
  fs.writeFileSync(provPath, JSON.stringify(userAddedAlias))
  await fetch(base + "/set/" + nextProfile, { method: "POST" })
  await fetch(base + "/set/off", { method: "POST" })
  eq(`off removes owned UA beside a manual alias after ${nextProfile}`, prov()[0].headers, { "X-Keep": "mine", "user-agent": "manual-alias/3", ORIGINATOR: "my-client" })
}
fs.writeFileSync(provPath, JSON.stringify(originalHeaderProviders))

const prototypeHeaderProviders = structuredClone(originalHeaderProviders)
prototypeHeaderProviders.providers.push({ id: "__proto__", baseAPI: "responses", responses: "http://x/v1", headers: { "user-agent": "original/1" } })
fs.writeFileSync(provPath, JSON.stringify(prototypeHeaderProviders))
await fetch(base + "/set/codex", { method: "POST" })
await fetch(base + "/set/pi", { method: "POST" })
await fetch(base + "/set/off", { method: "POST" })
eq("prototype-named provider restores original headers", prov().find((p) => p.id === "__proto__").headers, { "user-agent": "original/1" })
eq("prototype-named provider clears ownership ledger", Object.keys(JSON.parse(fs.readFileSync(cfgPath, "utf8")).appliedHeaders ?? {}), [])
fs.writeFileSync(provPath, JSON.stringify(originalHeaderProviders))

// Upgrade an active key-only ledger without treating old plugin values as originals.
await fetch(base + "/set/codex", { method: "POST" })
const legacyHeaderProviders = JSON.parse(fs.readFileSync(provPath, "utf8"))
legacyHeaderProviders.providers[0].headers["user-agent"] = "legacy-original/1"
const legacyCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
delete legacyCfg.appliedHeaders
for (const profile of ["codex", "pi", "off"]) {
  fs.writeFileSync(provPath, JSON.stringify(legacyHeaderProviders))
  fs.writeFileSync(cfgPath, JSON.stringify({ ...legacyCfg, profile }))
  eq(`legacy ${profile} migration starts successfully`, reloadHost().status, 0)
  await fetch(base + "/set/off", { method: "POST" })
  eq(`legacy ${profile} migration removes old plugin headers on off`, prov()[0].headers, { "X-Keep": "mine", "user-agent": "legacy-original/1" })
  eq(`legacy ${profile} migration removes headers without originals`, "headers" in prov()[1], false)
  eq(`legacy ${profile} migration clears ownership`, Object.keys(JSON.parse(fs.readFileSync(cfgPath, "utf8")).appliedHeaders ?? {}), [])
}
fs.writeFileSync(provPath, JSON.stringify(originalHeaderProviders))

// A custom profile may name the same header in any and protocol groups.
const aliasCfg = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
aliasCfg.profiles["case-aliases"] = {
  ua: "base/1",
  headers: { any: { "user-agent": "custom/2", ORIGINATOR: "any" }, openai: { originator: "openai" } },
}
fs.writeFileSync(cfgPath, JSON.stringify(aliasCfg))
await fetch(base + "/set/case-aliases", { method: "POST" })
eq("native custom UA has one case alias", Object.keys(prov()[0].headers).filter((k) => k.toLowerCase() === "user-agent"), ["user-agent"])
eq("native custom originator has one case alias", Object.keys(prov()[0].headers).filter((k) => k.toLowerCase() === "originator"), ["originator"])
eq("native custom protocol header wins", prov()[0].headers.originator, "openai")
await fetch(base + "/set/off", { method: "POST" })
eq("native custom aliases leave no plugin headers on off", prov()[0].headers, originalHeaderProviders.providers[0].headers)

// external rewrite of providers.json is self-healed by chatHeaders
await fetch(base + "/set/codex", { method: "POST" })
const wiped = JSON.parse(fs.readFileSync(provPath, "utf8"))
for (const p of wiped.providers) delete p.headers
fs.writeFileSync(provPath, JSON.stringify(wiped))
await apply("p-responses", "@ai-sdk/openai")
const healed = JSON.parse(fs.readFileSync(provPath, "utf8"))
const pResp = healed.providers.find((p) => p.id === "p-responses")
eq("external providers.json wipe self-healed", String(pResp?.headers?.["User-Agent"]).startsWith("codex_cli_rs/"), true)
await fetch(base + "/set/off", { method: "POST" })

// /config endpoint: pins, exclusions, overrides, custom profiles
async function postCfg(body) {
  const res = await fetch(base + "/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
  return { status: res.status, j: await res.json().catch(() => ({})) }
}
eq("state lists providers", (await (await fetch(base + "/state")).json()).providers.map((p) => p.id), ["zcode", "p-responses", "p-anthropic"])
let st0 = await (await fetch(base + "/state")).json()
eq("state names providers.json", [st0.providersPath, st0.providersError], [provPath, null])
fs.renameSync(provPath, provPath + ".away")
st0 = await (await fetch(base + "/state")).json()
eq("state says providers.json is missing", [st0.providers.map((p) => p.id), st0.providersError], [["zcode"], "not found"])
fs.renameSync(provPath + ".away", provPath)
let rc = await postCfg({ versions: { codex: "8.8.8" } })
eq("config saves pins", rc.j.ok, true)
await fetch(base + "/set/codex", { method: "POST" })
h = await apply("any", "@ai-sdk/anthropic")
eq("config pin wins", String(h["User-Agent"]).startsWith("codex_cli_rs/8.8.8 ("), true)
rc = await postCfg({ versions: { codex: "" } })
eq("config clears pins", rc.j.state.versions.values.codex.source, "builtin")

eq("bad id rejected", (await postCfg({ profiles: { "bad id!": { ua: "x/1" } } })).status, 400)
eq("bad pin rejected", (await postCfg({ versions: { codex: "not-a-version!" } })).status, 400)
eq("pin with trailing spaces rejected", (await postCfg({ versions: { codex: "1.0.0-bad spaces" } })).status, 400)
eq("unknown version key rejected", (await postCfg({ versions: { nope: "1.2.3" } })).status, 400)
eq("bad header key rejected", (await postCfg({ profiles: { ok1: { ua: "x/1", headers: { any: { "bad key": "v" } } } } })).status, 400)
eq("header with colon rejected", (await postCfg({ profiles: { badh: { ua: "x/1", headers: { any: { "Evil:Header": "1" } } } } })).status, 400)
eq("protected header Authorization rejected", (await postCfg({ profiles: { badauth: { ua: "x/1", headers: { any: { Authorization: "Bearer bad" } } } } })).status, 400)
eq("reserved profile id rejected", (await postCfg({ profiles: { off: { ua: "x/1" } } })).status, 400)
eq("override unknown profile rejected", (await postCfg({ providerOverrides: { newapi: "nope" } })).status, 400)
eq("bad excludes rejected", (await postCfg({ excludeProviders: ["x", 5] })).status, 400)
for (const name of ["constructor", "toString", "__proto__"]) {
  eq(`inherited profile ${name} rejected by set`, (await fetch(base + `/set/${name}`, { method: "POST" })).status, 400)
  eq(`inherited profile ${name} rejected by override`, (await postCfg({ providerOverrides: { newapi: name } })).status, 400)
}
eq("non-string override profile rejected", (await postCfg({ providerOverrides: { newapi: ["codex"] } })).status, 400)
for (const ctl of ["\r", "\n", "\0"]) {
  eq(`scalar UA rejects control ${ctl.charCodeAt(0)}`, (await postCfg({ profiles: { badua: { ua: `client/1${ctl}evil` } } })).status, 400)
  eq(`dual UA rejects control ${ctl.charCodeAt(0)}`, (await postCfg({ profiles: { badua: { forms: { openai: { ua: `client/1${ctl}evil` } } } } })).status, 400)
}
await fetch(base + "/set/off", { method: "POST" })

const csrfPost = await fetch(base + "/set/codex", {
  method: "POST",
  headers: { Origin: "https://evil.example.com", "Sec-Fetch-Site": "cross-site" },
})
eq("csrf cross-origin rejected", csrfPost.status, 403)
const badCtPost = await fetch(base + "/config", {
  method: "POST",
  headers: { "Content-Type": "text/plain" },
  body: JSON.stringify({ profile: "codex" }),
})
eq("config text/plain simple request rejected", badCtPost.status, 415)

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

rc = await postCfg({ versions: { pi: "2.2.0" } })
eq("config saves pi pin", rc.j.ok, true)
await fetch(base + "/set/pi", { method: "POST" })
eq("pinned pi version wins", (await apply("any", "@ai-sdk/anthropic"))["User-Agent"], "claude-cli/2.2.0")
rc = await postCfg({ versions: { pi: "" } })
eq("config clears pi pin", rc.j.ok, true)

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
eq("antigravity ua shape", /^antigravity\/hub\/\d+\.\d+\.\d+ \(aidev_client; os_type=\w+; arch=\w+\)$/.test(h["User-Agent"] ?? ""), true)
eq("antigravity sends no extra headers", Object.keys(h), ["User-Agent"])
rc = await postCfg({ versions: { antigravity: "2.24.0" } })
eq("antigravity pin accepted", rc.j.ok, true)
h = await apply("any", "@ai-sdk/openai")
eq("antigravity known cl", String(h["User-Agent"]).includes("; cl=1000335682)"), true)
rc = await postCfg({ versions: { antigravity: "" } })
eq("antigravity pin cleared", rc.j.ok, true)

// asar reader — antigravity version detection anchors on it
const asarPath = path.join(os.tmpdir(), `ua-switcher-selftest-${process.pid}.asar`)
{
  const pkg = Buffer.from(JSON.stringify({ name: "antigravity", version: "2.26.0" }))
  const header = Buffer.from(JSON.stringify({ files: { "package.json": { size: pkg.length, offset: "0" } } }))
  const jsonLen = header.length
  const headerSize = Math.ceil((jsonLen + 8) / 4) * 4
  const pre = Buffer.alloc(16)
  pre.writeUInt32LE(4, 0)
  pre.writeUInt32LE(headerSize, 4)
  pre.writeUInt32LE(headerSize - 4, 8)
  pre.writeUInt32LE(jsonLen, 12)
  fs.writeFileSync(asarPath, Buffer.concat([pre, header, Buffer.alloc(headerSize - 8 - jsonLen), pkg]))
}
const { readAsarPackageVersion } = await import("./index.mjs")
eq("asar reader parses package.json", readAsarPackageVersion(asarPath), "2.26.0")
eq("asar reader rejects missing file", readAsarPackageVersion(path.join(os.tmpdir(), "nope-does-not-exist.asar")), null)
const vsA = (await (await fetch(base + "/versions")).json()).values.antigravity
// the version comes from the local install when there is one, so only its
// shape and provenance are asserted, not a number this machine may update
eq("versions lists antigravity", /^\d+\.\d+\.\d+$/.test(vsA.inUse) && ["detected", "builtin", "fetched", "pinned"].includes(vsA.source), true)

// --- metadata.user_id (1.8.0): magpie's provider extraBody, no gateway hook ---
// The gateway hook (magpie.hooks) is gone on purpose: declaring one makes
// magpie copy every agent request body into the Bun host and deep-clone it
// there, even on requests the hook leaves alone. These tests guard both halves
// — that no hook is declared, and that the user_id still reaches upstream.
const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"))
eq("no gateway hook is declared", pkg.magpie?.hooks ?? null, null)
eq("hooks.mjs is not shipped", (pkg.files ?? []).includes("hooks.mjs"), false)
eq("hooks.mjs is gone from disk", fs.existsSync(new URL("./hooks.mjs", import.meta.url)), false)
eq("middleware is still declared", pkg.magpie?.middleware, "./schema.middleware.mjs")

const uidPath = cfgPath.replace(/\.json$/, "") + "-userid.json"
const provDoc = () => JSON.parse(fs.readFileSync(provPath, "utf8")).providers
const providerOf = (id) => provDoc().find((p) => p.id === id) ?? null
const metaOf = (id) => providerOf(id)?.extraBody?.metadata ?? null
const uidOf = (id) => metaOf(id)?.user_id ?? ""
const setProfile = async (name) => (await fetch(`${base}/set/${name}`, { method: "POST" })).json()
const cfgDoc = () => JSON.parse(fs.readFileSync(cfgPath, "utf8"))
const writeProviders = (mutate) => {
  const doc = JSON.parse(fs.readFileSync(provPath, "utf8"))
  mutate(doc.providers)
  fs.writeFileSync(provPath, JSON.stringify(doc))
}

await postCfg({ excludeProviders: ["zcode"], providerOverrides: {}, injectMetadata: true })
await setProfile("claude-code")
const USER_ID = /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}_session_[0-9a-f-]{36}$/
eq("extraBody carries a Claude Code user_id", USER_ID.test(uidOf("p-anthropic")), true)
eq("the responses wire gets no metadata", metaOf("p-responses"), null)
eq("an excluded provider gets no metadata", metaOf("zcode"), null)
eq("the claude-code UA still goes with it", String(providerOf("p-anthropic")?.headers?.["User-Agent"]).startsWith("claude-cli/"), true)
eq("state names the provider it wrote", (await (await fetch(`${base}/state`)).json()).metadata.providers, ["p-anthropic"])
eq("state hides the id itself", JSON.stringify((await (await fetch(`${base}/state`)).json()).metadata).includes(uidOf("p-anthropic")), false)

await setProfile("pi") // pi's anthropic form is the same identity
const uidPi = uidOf("p-anthropic")
eq("one user id across Claude Code profiles", uidPi, uidOf("p-anthropic"))
await setProfile("claude-code")
eq("and across a re-apply", uidOf("p-anthropic"), uidPi)
eq("user id persisted", fs.existsSync(uidPath), true)
const uidRaw = JSON.parse(fs.readFileSync(uidPath, "utf8"))
eq("persisted user_id has base_id", typeof uidRaw.base_id, "string")
eq("base_id matches expected format", /^user_[0-9a-f]{64}_account_[0-9a-f-]{36}$/i.test(uidRaw.base_id), true)
eq("user_id format has session", USER_ID.test(uidRaw.user_id), true)

// a provider that answers the Messages wire beside a responses one needs the
// id too: its Claude models go to the anthropic endpoint untranslated
writeProviders((ps) => {
  ps.find((p) => p.id === "p-responses").anthropic = "https://relay.example"
})
await setProfile("claude-code")
eq("a mixed provider gets the id too", USER_ID.test(uidOf("p-responses")), true)
await setProfile("off")
eq("off takes the mixed provider's back as well", providerOf("p-responses")?.extraBody ?? null, null)
writeProviders((ps) => {
  delete ps.find((p) => p.id === "p-responses").anthropic
})
await setProfile("claude-code")
eq("no metadata without a Messages endpoint", metaOf("p-responses"), null)

// 显式 baseAPI 优先于探测/手填的 responses URL：否则一个声明自己是
// anthropic 的中转站会被判成 openai，丢掉 anthropic 专属头
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-anthropic")
  p.baseAPI = "anthropic"
  p.responses = "https://relay.example/v1"
})
await setProfile("claude-code")
eq("an anthropic base wins over a responses URL", providerOf("p-anthropic")?.headers?.["anthropic-version"], "2023-06-01")
eq("and it still counts as a Messages provider", USER_ID.test(uidOf("p-anthropic")), true)
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-anthropic")
  delete p.baseAPI
  delete p.responses
})
await setProfile("claude-code")

// 值签名认领：账本说是插件写的，但用户已在 GUI 里改成别的形状 → 不删
writeProviders((ps) => {
  ps.find((p) => p.id === "p-anthropic").extraBody = { metadata: { user_id: "custom_corp", team: "sec" } }
})
const cfgWithClaim = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
cfgWithClaim.appliedMeta = { "p-anthropic": ["metadata"] }
fs.writeFileSync(cfgPath, JSON.stringify(cfgWithClaim))
await setProfile("off")
eq("hand-edited metadata survives a switch to off", providerOf("p-anthropic")?.extraBody?.metadata, { user_id: "custom_corp", team: "sec" })
eq("and the plugin drops the claim", cfgDoc().appliedMeta?.["p-anthropic"] ?? null, null)

// 反过来：账本丢了、值仍是插件的形状 → 不留孤儿字段
writeProviders((ps) => {
  ps.find((p) => p.id === "p-anthropic").extraBody = { metadata: { user_id: uidPi } }
})
const cfgNoLedger = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
delete cfgNoLedger.appliedMeta
fs.writeFileSync(cfgPath, JSON.stringify(cfgNoLedger))
await setProfile("off")
eq("an id the ledger lost is still cleaned up", providerOf("p-anthropic")?.extraBody ?? null, null)

// 纯 Gemini 的 provider 不写：generateContent 的解析器拒绝不认识的顶层字段
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-responses")
  p.baseAPI = "gemini"
  p.gemini = "https://generativelanguage.googleapis.com/v1beta"
})
await setProfile("claude-code")
eq("a gemini base gets no metadata", metaOf("p-responses"), null)
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-responses")
  delete p.baseAPI
  delete p.gemini
})
await setProfile("claude-code")

// wireOf 只修「显式 baseAPI 被 responses URL 抢先」这一处，
// 其余分支必须与 v1.7.0 逐字节等价——它决定的是所有档案的 headers 分组。
await setProfile("codex")
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-responses")
  p.baseAPI = "chat"
  p.responses = "https://x/v1"
})
await setProfile("codex")
eq("baseAPI chat with a responses URL still gets the openai group", String(providerOf("p-responses")?.headers?.["OpenAI-Beta"]).includes("responses"), true)
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-responses")
  delete p.baseAPI
})
await setProfile("codex")
eq("an omitted baseAPI with a responses URL is unchanged too", String(providerOf("p-responses")?.headers?.["OpenAI-Beta"]).includes("responses"), true)

// 只有 anthropic 端点、baseAPI 缺省：headers 仍按 v1.7.0 走 other 组，
// 但 metadata 该写还是写——两个判据故意不同宽
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-responses")
  delete p.responses
  p.anthropic = "https://x/anthropic"
})
await setProfile("claude-code")
eq("a lone anthropic endpoint does not move the headers", providerOf("p-responses")?.headers?.["anthropic-version"] ?? null, null)
eq("but it is a Messages provider for the user_id", USER_ID.test(uidOf("p-responses")), true)
writeProviders((ps) => {
  const p = ps.find((x) => x.id === "p-responses")
  p.responses = "http://x/v1"
  p.baseAPI = "responses"
  delete p.anthropic
})
await setProfile("off")

// 值签名认领：形状对但 base 不是本机的那个 user_id，不是插件写的
const foreignId = `user_${"0".repeat(64)}_account_00000000-0000-4000-8000-000000000000_session_00000000-0000-4000-8000-000000000000`
writeProviders((ps) => {
  ps.find((p) => p.id === "p-anthropic").extraBody = { metadata: { user_id: foreignId } }
})
const cfgForeign = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
cfgForeign.appliedMeta = { "p-anthropic": ["metadata"] }
fs.writeFileSync(cfgPath, JSON.stringify(cfgForeign))
await setProfile("claude-code")
eq("a real id the user copied in is not overwritten", uidOf("p-anthropic"), foreignId)
await setProfile("off")
eq("and not deleted either", uidOf("p-anthropic"), foreignId)
eq("the ledger claim alone is not enough", cfgDoc().appliedMeta?.["p-anthropic"] ?? null, null)

// 本机 base 认得出来，账本丢了也照样回收（上面那条已覆盖，这里补正面一例）
writeProviders((ps) => {
  ps.find((p) => p.id === "p-anthropic").extraBody = { metadata: { user_id: uidPi } }
})
const cfgNoLedger2 = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
delete cfgNoLedger2.appliedMeta
fs.writeFileSync(cfgPath, JSON.stringify(cfgNoLedger2))
await setProfile("off")
eq("our own base id is recognized without the ledger", providerOf("p-anthropic")?.extraBody ?? null, null)

// 版本下限提示：读不到 last-version 时保持沉默，绝不瞎猜
const stMeta = (await (await fetch(`${base}/state`)).json()).metadata
eq("state names the extraBody floor", stMeta.minMagpieVersion, "0.1.1191")
eq("and reports the detected version only when it read one", stMeta.magpieVersion === null || /^0\.1\.\d+$/.test(stMeta.magpieVersion), true)

// switching to another profile takes the field back
await setProfile("off")
eq("off removes the extraBody we wrote", providerOf("p-anthropic")?.extraBody ?? null, null)
eq("and the ledger with it", cfgDoc().appliedMeta?.["p-anthropic"] ?? null, null)
await setProfile("codex")
eq("a codex profile writes no metadata", metaOf("p-anthropic"), null)
await setProfile("claude-code")
eq("and switching back rewrites it", USER_ID.test(uidOf("p-anthropic")), true)

// a field the user set themselves is never touched, and never claimed
await setProfile("off")
writeProviders((ps) => {
  ps.find((p) => p.id === "p-anthropic").extraBody = { metadata: { user_id: "user_own" }, prompt_cache_key: "mine" }
})
await setProfile("claude-code")
eq("the user's own metadata survives", metaOf("p-anthropic"), { user_id: "user_own" })
eq("and is not claimed by the ledger", cfgDoc().appliedMeta?.["p-anthropic"] ?? null, null)
eq("the page says so", (await (await fetch(`${base}/state`)).json()).events.some((e) => String(e.text).includes("is not what this plugin writes")), true)
writeProviders((ps) => {
  const eb = ps.find((p) => p.id === "p-anthropic").extraBody
  delete eb.metadata
})
await setProfile("claude-code")
eq("with the user's field free, ours is written", USER_ID.test(uidOf("p-anthropic")), true)
eq("and the user's other field stays", providerOf("p-anthropic")?.extraBody?.prompt_cache_key, "mine")
await setProfile("off")
eq("off leaves the user's field alone", providerOf("p-anthropic")?.extraBody, { prompt_cache_key: "mine" })
writeProviders((ps) => {
  delete ps.find((p) => p.id === "p-anthropic").extraBody
})

// per-provider overrides and the injectMetadata switch
await postCfg({ providerOverrides: { "p-anthropic": "codex" } })
await setProfile("claude-code")
eq("an override away from Claude Code drops the id", metaOf("p-anthropic"), null)
await postCfg({ providerOverrides: {} })
await setProfile("claude-code")
eq("clearing the override brings it back", USER_ID.test(uidOf("p-anthropic")), true)
await postCfg({ injectMetadata: false })
eq("injectMetadata=false takes it back off", providerOf("p-anthropic")?.extraBody ?? null, null)
await postCfg({ injectMetadata: true })
eq("and turns it on again", USER_ID.test(uidOf("p-anthropic")), true)
await setProfile("off")

// userid.mjs: the same id from a second reader of the file
const ids = await import("./userid.mjs")
eq("userid.mjs exports the identity", USER_ID.test(ids.userId()), true)
eq("userid.mjs reuses the persisted base", ids.userId().replace(/_session_[0-9a-f-]{36}$/i, ""), uidPi.replace(/_session_[0-9a-f-]{36}$/i, ""))
eq("Claude Code profiles", [...ids.CLAUDE_CODE_PROFILES].sort(), ["claude-code", "pi"])

// --- gateway middleware (schema.middleware.mjs): top-level union cleanup ---
const { onRequest: schemaHook } = await import("./schema.middleware.mjs")
const mw = (b, protocol = "anthropic", options = {}) => schemaHook(b, { protocol, options }) ?? null

// the shape suian-zcode-app-mcp's send_message sends (zod .refine() output)
const suianTool = {
  name: "send_message",
  input_schema: {
    type: "object",
    properties: { message: { type: "string" }, message_file: { type: "string" } },
    required: ["message", "ghost_name"],
    $schema: "http://json-schema.org/draft-07/schema#",
    additionalProperties: false,
    oneOf: [{ required: ["message"] }, { required: ["message_file"] }],
  },
}
let mr = mw({ model: "m", tools: [suianTool] })
eq("mw strips top-level oneOf", "oneOf" in mr.tools[0].input_schema, false)
eq("mw keeps properties", Object.keys(mr.tools[0].input_schema.properties), ["message", "message_file"])
eq("mw drops dangling required", mr.tools[0].input_schema.required, ["message"])
eq("mw keeps unrelated keys", mr.tools[0].input_schema.$schema, "http://json-schema.org/draft-07/schema#")

// a schema that is nothing but a union: rebuild object + merged properties
const bareUnion = { name: "probe", input_schema: { oneOf: [{ type: "object", properties: { a: { type: "string" } } }, { type: "object", properties: { b: { type: "string" } } }] } }
mr = mw({ model: "m", tools: [bareUnion] })
eq("mw merges union properties", Object.keys(mr.tools[0].input_schema.properties), ["a", "b"])
eq("mw adds object type", mr.tools[0].input_schema.type, "object")

// empty schema gets the minimum Anthropic requires
mr = mw({ model: "m", tools: [{ name: "z", input_schema: {} }] })
eq("mw fills a bare schema", [mr.tools[0].input_schema.type, mr.tools[0].input_schema.properties], ["object", {}])

// untouched when already clean, or out of scope
const clean = { model: "m", tools: [{ name: "x", input_schema: { type: "object", properties: { a: { type: "string" } } } }] }
eq("mw leaves clean schemas alone", mw(clean), null)
eq("mw skips responses wire", mw({ model: "m", tools: [suianTool] }, "responses"), null)
eq("mw skips chat wire", mw({ model: "m", tools: [suianTool] }, "chat"), null)
eq("mw skips requests without tools", mw({ model: "m" }), null)
eq("mw honors disable option", mw({ model: "m", tools: [suianTool] }, "anthropic", { disable: true }), null)

// diagnose (1.8.0): the shapes Anthropic rejects are logged, not written to a
// file — moejs has no file system, and the gateway hook that had one is gone.
// A fresh tool each time: fixTool below edits the schema it is handed.
const oddTool = () => ({ name: "probe_a", input_schema: { type: "object", anyOf: [{ required: ["a"] }, { required: ["b"] }] } })
const warns = []
const realWarn = console.warn
console.warn = (...a) => warns.push(a.join(" "))
try {
  mw({ model: "m", tools: [oddTool()] }, "anthropic", { diagnose: true })
  mw({ model: "m", tools: [oddTool()] }, "anthropic", { diagnose: true })
  mw({ model: "m", tools: [{ name: "clean", input_schema: { type: "object" } }] }, "anthropic", { diagnose: true })
  mw({ model: "m", tools: [{ name: "probe_b", input_schema: { properties: {} } }] }, "anthropic")
} finally {
  console.warn = realWarn
}
eq("diagnose names the odd tool", warns.length === 1 && warns[0].includes("probe_a(anyOf"), true)
eq("the same shape is not logged twice", warns.length, 1)
eq("diagnose needs the option", warns.length, 1)

// 1.7.0 的 diagnose 写法不再被静默吞掉：配置文件里留着这个键时，页面日志给一次指引
{
  const c = JSON.parse(fs.readFileSync(cfgPath, "utf8"))
  c.diagnose = true
  fs.writeFileSync(cfgPath, JSON.stringify(c))
  const ev = (await (await fetch(`${base}/state`)).json()).events
  eq("the old diagnose key gets a pointer, not silence", ev.some((e) => String(e.text).includes("magpie plugin options ua-switcher")), true)
  const countPointer = async () =>
    (await (await fetch(`${base}/state`)).json()).events.filter((e) => String(e.text).includes("no longer reads")).length
  eq("and it speaks once, not on every poll", await countPointer(), 1)
  delete c.diagnose
  fs.writeFileSync(cfgPath, JSON.stringify(c))
  await fetch(`${base}/state`)
  eq("and never repeats after the key is gone", await countPointer(), 1)
}

// nested unions are legal for Anthropic and must survive
const nested = { name: "n", input_schema: { type: "object", properties: { p: { oneOf: [{ type: "string" }, { type: "number" }] } } } }
const nestedBody = { model: "m", tools: [nested] }
eq("mw keeps nested unions", mw(nestedBody), null)
eq("mw nested union intact", JSON.stringify(nested.input_schema.properties.p.oneOf.length), "2")

// composite top-level properties + oneOf branches
const compositeUnion = {
  name: "comp",
  input_schema: {
    type: "object",
    properties: { base: { type: "string" } },
    oneOf: [{ properties: { a: { type: "string" } } }, { properties: { b: { type: "number" } } }],
  },
}
mr = mw({ model: "m", tools: [compositeUnion] })
eq("mw preserves base and branch properties", Object.keys(mr.tools[0].input_schema.properties).sort(), ["a", "b", "base"])

// branch property conflict merges into anyOf
const conflictUnion = {
  name: "conf",
  input_schema: {
    type: "object",
    oneOf: [
      { properties: { mode: { type: "string", enum: ["fast"] } } },
      { properties: { mode: { type: "string", enum: ["slow"] } } },
    ],
  },
}
mr = mw({ model: "m", tools: [conflictUnion] })
eq("mw merges conflicting branch property as anyOf", Array.isArray(mr.tools[0].input_schema.properties.mode.anyOf), true)
eq("mw conflicting anyOf branch count", mr.tools[0].input_schema.properties.mode.anyOf.length, 2)

// --- ui.html: a routing choice is committed the moment it is made ---
// 1.8.1 and earlier read these dropdowns only inside 「保存路由设置」. The page polls
// /state every 3s and rebuilds the table from S, so a choice that was never posted got
// replaced by the stored config a few seconds later and the row snapped back to 跟随全局.
{
  const ui = fs.readFileSync(new URL("./ui.html", import.meta.url), "utf8")
  eq("ui: the dropdowns have a delegated change handler", /\$\("#prov-tbody"\)\.addEventListener\("change"/.test(ui), true)
  eq("ui: the handler recognises a routing select", /closest\("\.prov-route-sel"\)/.test(ui), true)
  eq("ui: a change seeds from S, so hidden rows keep their route", /deriveRouting\(sel\.dataset\.id, sel\.value, S\.excludeProviders, S\.providerOverrides\)/.test(ui), true)
  eq("ui: the poll will not rebuild the table over an open dropdown", /if \(routeTableIsOpen\(\) && !routeRenderForced\) return;/.test(ui), true)
  eq("ui: a commit the server rejected rebuilds the row anyway", /routeRenderForced = true;[\s\S]{0,40}await load\(true, true\)/.test(ui), true)
  eq("ui: the poll will not overwrite S during a save", /if \(silent && routeBusy > 0 && !force\)/.test(ui), true)
  eq("ui: the page resyncs from the server around every commit", /await load\(true, true\)/.test(ui), true)
  eq("ui: offline preview keeps the choice in the front end", /演示模式：路由改动只停留在前端/.test(ui), true)
  eq("ui: 「保存路由设置」 still batch-commits", /\$\("#save-routing"\)\.onclick/.test(ui), true)

  // deriveRouting is the single place the two config fields are computed — run it.
  const src = ui.match(/function deriveRouting[\s\S]*?\n    }/)[0]
  const deriveRouting = new Function(src + "; return deriveRouting;")()
  // order-insensitive view of the payload, since eq() compares JSON text
  const dr = (id, val, ex, ov) => {
    const r = deriveRouting(id, val, ex, ov)
    return {
      excludeProviders: [...r.excludeProviders].sort(),
      providerOverrides: Object.keys(r.providerOverrides).sort().map((k) => `${k}=${r.providerOverrides[k]}`),
    }
  }
  eq("ui: 跟随全局 clears both fields", dr("p1", "__global__", ["p1"], { p1: "codex" }), { excludeProviders: [], providerOverrides: [] })
  eq("ui: 排除 replaces a stale lock", dr("p1", "__exclude__", [], { p1: "codex" }), { excludeProviders: ["p1"], providerOverrides: [] })
  eq("ui: a lock replaces a stale exclusion", dr("p1", "claude-code", ["p1"], {}), { excludeProviders: [], providerOverrides: ["p1=claude-code"] })
  eq("ui: rows outside the filter survive the commit", dr("p2", "codex", ["p1"], { p3: "pi" }), { excludeProviders: ["p1"], providerOverrides: ["p2=codex", "p3=pi"] })
  eq("ui: an unset config does not throw", dr("p1", "__global__", undefined, undefined), { excludeProviders: [], providerOverrides: [] })
  eq("ui: the posted body carries exactly the two fields", Object.keys(deriveRouting("p1", "codex", [], {})).sort(), ["excludeProviders", "providerOverrides"])
}

// --- ui.html 1.8.3: the two button-committed editors stop losing work to the poll ---
// 1.8.2 fixed only the routing table. Version pins and the custom-profile studio are
// the same shape — nothing is sent until their button is clicked — and the 3s poll
// rebuilt both over the top of whatever was being typed. Header rows lived only in the
// DOM, so even an added row vanished; a new card vanished with S being replaced.
{
  const ui = fs.readFileSync(new URL("./ui.html", import.meta.url), "utf8")
  eq("ui: the version table stands down while a pin is focused", /if \(!force && sectionIsBeingEdited\("#ver-tbody"\)\) return;/.test(ui), true)
  eq("ui: the studio stands down while it is being edited", /if \(!force && sectionIsBeingEdited\("#cp-list"\)\) return;/.test(ui), true)
  eq("ui: a typed pin lands in the draft", /pinDraft\[i\.dataset\.key\] = i\.value;/.test(ui), true)
  eq("ui: clearing a pin is a draft too", /pinDraft\[btn\.dataset\.key\] = ""/.test(ui), true)
  eq("ui: the studio snapshots its cards on input", /\$\("#cp-list"\)\.addEventListener\("input"/.test(ui), true)
  eq("ui: and on change, for the protocol picker", /\$\("#cp-list"\)\.addEventListener\("change"/.test(ui), true)
  eq("ui: adding a header row snapshots", /hdrList\.appendChild\(div\);\s*\n\s*snapshotCpCard\(card\);/.test(ui), true)
  eq("ui: removing a header row snapshots", /btn\.closest\("\.hdr-row"\)\.remove\(\);\s*\n\s*snapshotCpCard\(card\);/.test(ui), true)
  eq("ui: deleting a saved card tombstones instead of editing S", /cpDraft\[id\] = null;/.test(ui), true)
  eq("ui: a card that was only a draft is dropped outright", /else delete cpDraft\[id\];/.test(ui), true)
  eq("ui: the studio no longer writes drafts into S", /S\.customProfiles\[id\] = \{/.test(ui), false)
  eq("ui: a committed profile clears the profile draft", /cpDraft = \{\}; \/\/ committed/.test(ui), true)
  eq("ui: a committed pin clears the pin draft", /pinDraft = \{\}; \/\/ committed/.test(ui), true)
  eq("ui: one reader for the draft and the commit", /readCpCard\(c, true\)/.test(ui), true)
  eq("ui: closing the tab with a draft warns", /addEventListener\("beforeunload"/.test(ui), true)
  eq("ui: user-initiated renders are forced past the guard", /renderCustomProfiles\(true\)/.test(ui), true)

  // applyDraft decides what the cards show: server truth with the draft folded over it.
  const ad = new Function(ui.match(/function applyDraft[\s\S]*?\n    }/)[0] + "; return applyDraft;")()
  const srv = { a: { label: "A" }, b: { label: "B" } }
  eq("ui: a draft edits a saved profile", ad(srv, { a: { label: "A2" } }), { a: { label: "A2" }, b: { label: "B" } })
  eq("ui: a tombstone hides a saved profile", ad(srv, { b: null }), { a: { label: "A" } })
  eq("ui: a draft-only id still shows", ad(srv, { c: { label: "C" } }), { a: { label: "A" }, b: { label: "B" }, c: { label: "C" } })
  eq("ui: an empty draft is the server's map", ad(srv, {}), srv)
  eq("ui: no missing base throws", ad(undefined, { a: null }), {})
  eq("ui: the server's own map is never mutated", Object.keys(srv).join(","), "a,b")

  // A row the user has not finished typing carries no header, but it must still be
  // there after the next tick: the draft keeps every row verbatim, and only the
  // valid ones go into what 保存 sends.
  eq("ui: every row is captured, filled or not", /rows\.push\(\{ proto, k, v \}\);/.test(ui), true)
  eq("ui: the draft carries the rows", /cpDraft\[id\] = \{ \.\.\.obj, rows \}/.test(ui), true)
  eq("ui: a draft card renders its own rows", /Array\.isArray\(p\.rows\) \? p\.rows : flattenCustomHeaders/.test(ui), true)
  eq("ui: one row template for the render and for 添加", /div\.innerHTML = hdrRowHtml\(/.test(ui), true)
  eq("ui: the commit sends obj only, never the rows", /const \{ id, obj \} = readCpCard\(c, true\)/.test(ui), true)
  eq("ui: no row-counting trick left behind", /blank/.test(ui), false)

  const rcSrc = ui.match(/function readCpCard[\s\S]*?\n    }/)[0]
  const input = (v) => ({ value: v, classList: { add() {}, remove() {} } })
  const fakeCard = (id, label, ua, rows) => ({
    dataset: { id },
    querySelector: (s) => (s === ".cp-lbl" ? input(label) : s === ".cp-ua" ? input(ua) : null),
    querySelectorAll: (s) =>
      s === ".hdr-row"
        ? rows.map((r) => ({
            querySelector: (k) =>
              k === ".hdr-proto" ? input(r.proto || "any") : k === ".hdr-k" ? input(r.k) : input(r.v),
          }))
        : [],
  })
  const readCpCard = new Function(
    "cpDraft",
    "S",
    "HEADER_KEY_RE",
    "FORBIDDEN_HEADERS",
    rcSrc + "; return readCpCard;",
  )({}, { customProfiles: {} }, /^[A-Za-z0-9!#$%&'*+\-.^_`|~]{1,64}$/, new Set(["authorization", "host"]))
  const half = readCpCard(fakeCard("x", "X", "MyAgent/1.0", [{ k: "X-Tag", v: "" }, { k: "", v: "" }, { k: "Bad Name:", v: "y" }]), false)
  eq("ui: rows keep their order and their half-typed content", half.rows.map((r) => `${r.proto}/${r.k}/${r.v}`).join(" | "), "any/X-Tag/ | any// | any/Bad Name:/y")
  eq("ui: nothing unfinished or illegal reaches the payload", JSON.stringify(half.obj.headers ?? null), "null")
  eq("ui: a half-typed row is not silently dropped from the draft", Object.keys(half.obj).sort().join(","), "label,ua")
  const filled = readCpCard(fakeCard("x", "X", "MyAgent/1.0", [{ k: "X-Tag", v: "hi" }]), false)
  eq("ui: a filled row is both a row and a header", [filled.rows.length, JSON.stringify(filled.obj.headers)].join(","), '1,{"any":{"X-Tag":"hi"}}')
  const forbidden = fakeCard("x", "X", "U", [{ k: "Authorization", v: "Bearer x" }])
  eq("ui: strict still throws on a protected header", (() => { try { readCpCard(forbidden, true); return "no throw"; } catch (e) { return /受保护/.test(e.message) ? "throws" : e.message; } })(), "throws")
  eq("ui: a snapshot keeps the row and stays quiet", (() => { const r = readCpCard(forbidden, false); return [r.rows.length, JSON.stringify(r.obj.headers ?? null)].join(",") })(), "1,null")
}

// --- paths.mjs: magpie's folder as appdir.Config() decides it ---
const paths = await import("./paths.mjs")
const ptmp = fs.mkdtempSync(path.join(os.tmpdir(), "ua-switcher-paths-"))
const fakeHome = path.join(ptmp, "home")
const home = () => fakeHome
paths.resetMagpieDir()
eq("dir: absolute XDG_CONFIG_HOME wins", paths.magpieDir({ XDG_CONFIG_HOME: path.join(ptmp, "xdg") }, home), path.join(ptmp, "xdg", "magpie"))
eq("dir: relative XDG_CONFIG_HOME ignored", paths.magpieDir({ XDG_CONFIG_HOME: "rel/xdg" }, home), path.join(fakeHome, ".config", "magpie"))
eq("dir: empty XDG_CONFIG_HOME ignored", paths.magpieDir({ XDG_CONFIG_HOME: "" }, home), path.join(fakeHome, ".config", "magpie"))
eq("dir: no XDG falls back to ~/.config", paths.magpieDir({}, home), path.join(fakeHome, ".config", "magpie"))
const handed = path.join(ptmp, "portable", "data")
fs.mkdirSync(handed, { recursive: true })
eq("dir: relative input.directory refused", paths.useMagpieDir("portable/data"), false)
eq("dir: input.directory without magpie's files refused", paths.useMagpieDir(handed), false)
fs.writeFileSync(path.join(handed, "settings.json"), "{}")
eq("dir: input.directory with magpie's files taken", paths.useMagpieDir(handed), true)
eq("dir: input.directory beats XDG", paths.magpieDir({ XDG_CONFIG_HOME: path.join(ptmp, "xdg") }, home), handed)
paths.resetMagpieDir()
eq("paths: UA_SWITCHER_CONFIG still overrides", paths.configPath(), cfgPath)
eq("paths: UA_SWITCHER_PROVIDERS still overrides", paths.providersPath(), provPath)
eq("paths: files beside the config", paths.besideConfig("-userid.json"), uidPath)

// 1.6.0 and before wrote to ~/.config/magpie whatever magpie used
const oldDir = path.join(fakeHome, ".config", "magpie")
fs.mkdirSync(oldDir, { recursive: true })
fs.writeFileSync(path.join(oldDir, "ua-switcher.json"), JSON.stringify({ profile: "codex" }))
const moved = path.join(ptmp, "xdg", "magpie", "ua-switcher.json")
eq("legacy: copied when the new file is missing", paths.adoptLegacy(moved, home), oldDir)
eq("legacy: copy holds the old profile", JSON.parse(fs.readFileSync(moved, "utf8")).profile, "codex")
fs.writeFileSync(moved, JSON.stringify({ profile: "pi" }))
eq("legacy: an existing file is never overwritten", [paths.adoptLegacy(moved, home), JSON.parse(fs.readFileSync(moved, "utf8")).profile], ["", "pi"])
eq("legacy: nothing to copy", paths.adoptLegacy(path.join(ptmp, "xdg", "magpie", "ua-switcher-userid.json"), home), "")
eq("legacy: same folder is left alone", paths.adoptLegacy(path.join(oldDir, "ua-switcher.json"), home), "")
eq("legacy: non-whitelisted file refused", paths.adoptLegacy(path.join(ptmp, "xdg", "magpie", "evil.json"), home), "")
fs.rmSync(ptmp, { recursive: true, force: true })

// --- providersForUi(): /state must not re-read providers.json on every poll ---
// The page polls every 3s; the config, the npm cache and the ASAR probe all keyed
// off mtime already, but this one call parsed the whole file each time.
{
  const realRead = fs.readFileSync
  let reads = 0
  fs.readFileSync = (...a) => {
    if (String(a[0]) === provPath) reads++
    return realRead(...a)
  }
  const bumpMtime = () => {
    const st = fs.statSync(provPath)
    fs.utimesSync(provPath, new Date(), new Date(st.mtimeMs + 5000)) // mtime is the key
  }
  try {
    await fetch(base + "/state") // the first call always reads: it arms the cache
    reads = 0
    await fetch(base + "/state")
    await fetch(base + "/state")
    eq("providers.json is not re-read while unchanged", reads, 0)
    writeProviders((ps) => ps.push({ id: "p-added", key: "sk-x", baseURL: "https://d.example/anthropic" }))
    bumpMtime()
    reads = 0
    const list = (await (await fetch(base + "/state")).json()).providers.map((p) => p.id)
    eq("a providers.json written elsewhere is read once", reads, 1)
    eq("and the provider added outside shows up", list.includes("p-added"), true)
    reads = 0
    await fetch(base + "/state")
    eq("the cache re-arms behind that read", reads, 0)
  } finally {
    fs.readFileSync = realRead
  }
}

console.error(failures ? `\n${failures} FAILURES` : "\nall tests passed")
process.exit(failures ? 1 : 0)

// Real loopback forwarding and persisted provider ownership; no live config.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"

const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-billing-test-"))
const cfgPath = path.join(root, "ua-switcher.json")
const provPath = path.join(root, "providers.json")
process.env.UA_SWITCHER_CONFIG = cfgPath
process.env.UA_SWITCHER_PROVIDERS = provPath
fs.writeFileSync(cfgPath, JSON.stringify({ profile: "claude-code", port: 0, autoVersions: false }))
fs.writeFileSync(path.join(root, "plugins.json"), JSON.stringify({ plugins: [] }))
let last, hits = 0, status = 200, slow = false
const echo = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 0, async fetch(req) {
  hits++
  const bytes = new Uint8Array(await req.arrayBuffer())
  last = { bytes, headers: req.headers, path: new URL(req.url).pathname, query: new URL(req.url).search }
  if (slow) return new Response(new ReadableStream({ async start(controller) {
    controller.enqueue(bytes.slice(0, 1))
    await Bun.sleep(11500)
    controller.enqueue(bytes.slice(1))
    controller.close()
  } }), { headers: { "content-type": "application/json" } })
  if (status === 302) return new Response(null, { status, headers: { location: "http://example.invalid/leak" } })
  return new Response(bytes.length ? bytes : "OK", { status, headers: { "content-type": "application/json" } })
} })
const original = `http://127.0.0.1:${echo.port}/relay`
const fixtures = [
  { id: "a", anthropic: original, baseAPI: "anthropic", proxy: "direct" },
  { id: "b", anthropic: original, responses: "https://example.invalid/v1", baseAPI: "responses", proxy: "direct" },
  { id: "excluded", anthropic: original, baseAPI: "anthropic", proxy: "direct" },
  { id: "openai", responses: "https://example.invalid/v1", baseAPI: "responses", proxy: "direct" },
  { id: "tls", anthropic: original, baseAPI: "anthropic", proxy: "direct", serverPin: "synthetic" },
  { id: "proxy", anthropic: original, baseAPI: "anthropic", proxy: "socks5://127.0.0.1:9" },
]
fs.writeFileSync(provPath, JSON.stringify({ providers: fixtures }))
const providers = () => JSON.parse(fs.readFileSync(provPath)).providers
const { UASwitcherPlugin } = await import("./index.mjs")
await UASwitcherPlugin({}, {})
let base = `http://127.0.0.1:${globalThis.__uaSwitcherServer.port}`
const state = async () => (await fetch(base + "/state")).json()
const config = async patch => {
  const r = await fetch(base + "/config", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) })
  assert.equal(r.status, 200, await r.clone().text())
  return r.json()
}
const set = async name => { assert.equal((await fetch(base + "/set/" + name, { method: "POST" })).status, 200) }
let checks = 0
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++ }
const system = [{ type: "text", text: "Caller system", cache_control: { type: "ephemeral" } }]
const body = { model: "claude-sonnet-4-6", max_tokens: 16, messages: [{ role: "user", content: "abcdefghijklmnopqrstuvwxyz" }], system }
async function send(url, payload = body, extra = {}, endpoint = "/v1/messages") {
  return fetch(url + endpoint, { method: "POST", headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.322 (external, cli)", "x-api-key": "synthetic-key", ...extra }, body: typeof payload === "string" ? payload : JSON.stringify(payload) })
}
try {
  check("default off keeps original endpoints", providers()[0].anthropic, original)
  check("default off visible", (await state()).claudeBilling, false)
  await config({ claudeBilling: true, excludeProviders: ["excluded"], providerOverrides: { b: "claude-code" } })
  const ps = providers()
  assert.notEqual(ps[0].anthropic, original, "enabled billing must route final wire through loopback")
  checks++
  assert.notEqual(ps[1].anthropic, original, "mixed provider's Messages endpoint is included")
  checks++
  check("unrelated Responses endpoint preserved", ps[1].responses, fixtures[1].responses)
  for (const id of ["excluded", "openai", "tls", "proxy"]) check(id + " unchanged", ps.find(p => p.id === id).anthropic, fixtures.find(p => p.id === id).anthropic)
  const s = await state()
  check("UI identifies active providers", s.billing.providers, ["a", "b"])
  assert.ok(s.billing.unavailable.tls && s.billing.unavailable.proxy); checks++
  const route = ps[0].anthropic
  check("forwarding succeeds", (await send(route)).status, 200)
  const transformed = JSON.parse(new TextDecoder().decode(last.bytes))
  const fp = createHash("sha256").update("59cf53e54c78ehu2.1.322").digest("hex").slice(0, 3)
  check("billing version/fingerprint", transformed.system[0].text, `x-anthropic-billing-header: cc_version=2.1.322.${fp}; cc_entrypoint=cli;`)
  check("caller system/cache kept", transformed.system.slice(1), system)
  check("billing cache flag absent", transformed.system[0].cache_control, undefined)
  check("fixed path mapping", last.path, "/relay/v1/messages")
  check("credentials retained", last.headers.get("x-api-key"), "synthetic-key")
  check("no invented auxiliary class", last.headers.get("x-claude-code-request-class"), null)
  await send(route, body, {}, "/v1/messages/count_tokens")
  check("count tokens unchanged", JSON.parse(new TextDecoder().decode(last.bytes)), body)
  const real = { ...body, system: [{ type: "text", text: "x-anthropic-billing-header: real;" }, ...system] }
  await send(route, real)
  check("existing genuine billing kept", JSON.parse(new TextDecoder().decode(last.bytes)), real)
  await send(route, "bad json")
  check("malformed body retained", new TextDecoder().decode(last.bytes), "bad json")
  await send(route, body, { "user-agent": "other/1" })
  check("other UA untouched", JSON.parse(new TextDecoder().decode(last.bytes)), body)
  const beforeHits = hits
  check("browser requests rejected", (await send(route, body, { origin: base })).status, 403)
  check("unknown endpoint rejected", (await send(route, body, {}, "/private")).status, 404)
  check("denied requests did not reach target", hits, beforeHits)
  status = 302
  check("redirect not followed", (await send(route)).status, 502)
  status = 200
  await config({ claudeBilling: true })
  check("reapply stable URL", providers()[0].anthropic, route)
  await UASwitcherPlugin({}, {})
  base = `http://127.0.0.1:${globalThis.__uaSwitcherServer.port}`
  check("restart restores target, does not chain loopbacks", (await send(providers()[0].anthropic)).status, 200)
  check("restart retains original upstream", last.path, "/relay/v1/messages")
  await set("off")
  check("off restores original", providers()[0].anthropic, original)
  check("independent Claude override remains active", (await state()).billing.providers, ["b"])
  await config({ providerOverrides: {}, claudeBilling: false })
  check("global off restores override too", providers()[1].anthropic, original)
  await set("claude-code")
  await config({ claudeBilling: true })
  const edited = providers()
  edited[0].anthropic = original + "/manual"
  fs.writeFileSync(provPath, JSON.stringify({ providers: edited }))
  await config({ claudeBilling: false })
  check("manual endpoint wins on disable", providers()[0].anthropic, original + "/manual")
  const invalid = await fetch(base + "/config", { method: "POST", headers: { "content-type": "application/json" }, body: '{"claudeBilling":"yes"}' })
  check("nonboolean configuration rejected", invalid.status, 400)
  await config({ claudeBilling: true })
  fs.writeFileSync(provPath, JSON.stringify({ providers: providers().filter(p => p.id !== "a") }))
  await config({ claudeBilling: true })
  check("removed provider has no stale URL ownership", Object.hasOwn(JSON.parse(fs.readFileSync(cfgPath)).appliedBilling, "a"), false)
  const settingsPath = path.join(root, "settings.json")
  fs.writeFileSync(settingsPath, JSON.stringify({ proxy: "direct" }))
  fs.writeFileSync(provPath, JSON.stringify({ providers: [...providers(), { id: "inherited", anthropic: original }] }))
  await config({ claudeBilling: true })
  check("explicit global direct supported", providers().find(p => p.id === "inherited").anthropic.includes("/_ua_claude/"), true)
  fs.writeFileSync(settingsPath, JSON.stringify({ proxy: "socks5://127.0.0.1:9" }))
  await Bun.sleep(1600)
  check("global proxy change restores unsupported endpoint", providers().find(p => p.id === "inherited").anthropic, original)
  slow = true
  const slowReply = await send(providers().find(p => p.id === "b").anthropic)
  check("stream survives a model pause longer than ten seconds", Array.isArray(JSON.parse(await slowReply.text()).system), true)
  console.log(JSON.stringify({ checks, allPassed: true, liveConfigTouched: false }))
} finally {
  echo.stop(true)
  globalThis.__uaSwitcherServer?.stop(true)
}

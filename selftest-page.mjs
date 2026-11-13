// Embedded API boundaries and auxiliary-host ownership; temporary config only.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
const root = fs.mkdtempSync(path.join(os.tmpdir(), "ua-page-test-"))
const cfg = path.join(root, "ua-switcher.json"), prov = path.join(root, "providers.json")
process.env.UA_SWITCHER_CONFIG = cfg
process.env.UA_SWITCHER_PROVIDERS = prov
fs.writeFileSync(cfg, JSON.stringify({ port: 0, autoVersions: false }))
fs.writeFileSync(prov, '{"providers":[]}')
fs.writeFileSync(path.join(root, "plugins.json"), '{"plugins":[]}')
const { UASwitcherPlugin } = await import("./index.mjs")
await UASwitcherPlugin({}, {})
const base = `http://127.0.0.1:${globalThis.__uaSwitcherServer.port}`
let checks = 0
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++ }
try {
  const bootstrap = await fetch(base + "/?embedded=1", { redirect: "manual", headers: { origin: "null" } })
  check("embedded bootstrap redirects", bootstrap.status, 302)
  check("bootstrap is not CORS readable", bootstrap.headers.get("access-control-allow-origin"), null)
  const location = bootstrap.headers.get("location")
  check("embedded capability is random", /^\/_ua_ui\/[0-9a-f]{48}\/$/.test(location), true)
  const embedded = base + location
  const html = await fetch(embedded, { headers: { origin: "null" } })
  check("embedded UI accepts opaque sandbox", html.status, 200)
  check("embedded UI does not deny its frame", html.headers.get("x-frame-options"), null)
  check("embedded page never cached", html.headers.get("cache-control"), "no-store")
  const preflight = await fetch(embedded + "config", { method: "OPTIONS", headers: { origin: "null", "access-control-request-method": "POST", "access-control-request-headers": "content-type" } })
  check("opaque sandbox preflight", preflight.status, 204)
  check("opaque sandbox CORS scoped", preflight.headers.get("access-control-allow-origin"), "null")
  const changed = await fetch(embedded + "config", { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: '{"claudeBilling":true,"providerOverrides":{},"excludeProviders":[]}' })
  check("embedded save works", (await changed.json()).ok, true)
  check("embedded save persists canonical config", JSON.parse(fs.readFileSync(cfg)).claudeBilling, true)
  check("ordinary API still rejects opaque origin", (await fetch(base + "/state", { headers: { origin: "null" } })).status, 403)
  check("capability rejects external origin", (await fetch(embedded + "state", { headers: { origin: "https://example.invalid" } })).status, 403)
  check("invalid capability cannot save", (await fetch(base + "/_ua_ui/" + "0".repeat(48) + "/config", { method: "POST", headers: { origin: "null", "content-type": "application/json" }, body: '{"claudeBilling":false}' })).status, 404)
  const normal = await fetch(base)
  check("standalone still denies frames", normal.headers.get("x-frame-options"), "DENY")
  const persisted = fs.readFileSync(cfg, "utf8")
  // Magpie assigns non-page CLI plugin hosts an ephemeral service port.
  const auxiliary = spawnSync(process.execPath, ["--eval", `import { UASwitcherPlugin } from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)}; await UASwitcherPlugin({}, {port: 12345}); console.log(JSON.stringify({listening:!!globalThis.__uaSwitcherServer})); process.exit(0);`], { env: process.env, windowsHide: true, encoding: "utf8" })
  check("auxiliary host exits cleanly", auxiliary.status, 0)
  check("auxiliary host never starts canonical service", auxiliary.stdout.includes('"listening":false'), true)
  check("auxiliary host preserves config", fs.readFileSync(cfg, "utf8"), persisted)
  const managed = path.join(root, "managed")
  fs.mkdirSync(managed)
  fs.writeFileSync(path.join(managed, "ua-switcher.json"), '{"port":12346,"autoVersions":false,"log":"off"}')
  fs.writeFileSync(path.join(managed, "providers.json"), '{"providers":[]}')
  fs.writeFileSync(path.join(managed, "plugins.json"), JSON.stringify({ plugins: [{ spec: fileURLToPath(new URL("./", import.meta.url)) }] }))
  const managedHost = spawnSync(process.execPath, ["--eval", `import { UASwitcherPlugin } from ${JSON.stringify(new URL("./index.mjs", import.meta.url).href)}; await UASwitcherPlugin({}, {port:12345}); console.log(JSON.stringify({listening:!!globalThis.__uaSwitcherServer})); process.exit(0);`], {
    env: { ...process.env, UA_SWITCHER_CONFIG: path.join(managed, "ua-switcher.json"), UA_SWITCHER_PROVIDERS: path.join(managed, "providers.json") }, windowsHide: true, encoding: "utf8"
  })
  check("registered default port host exits cleanly", managedHost.status, 0)
  check("registered page uses manifest default instead of stale config port", JSON.parse(fs.readFileSync(path.join(managed, "ua-switcher.json"))).port, 3426)
  check("registered auxiliary host never binds default port", managedHost.stdout.includes('"listening":false'), true)
  const manifest = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url)))
  check("Magpie page registered", manifest.magpie.page?.file, "page.html")
  check("page service matches option", manifest.magpie.page?.service, { port: 3426, option: "port" })
  console.log(JSON.stringify({ checks, allPassed: true, liveConfigTouched: false }))
} finally { globalThis.__uaSwitcherServer?.stop(true) }

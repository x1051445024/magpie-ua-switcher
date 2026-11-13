// Network behavior of the actual forwarding listener, using loopback only.
import assert from "node:assert/strict"
import { gzipSync } from "node:zlib"
import { BILLING_BODY_LIMIT, BILLING_PREFIX, addBilling, createBillingTransport } from "./claude-billing.mjs"

let mode = "gzip", canceled = false, observed
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
  observed = { bytes: new Uint8Array(await request.arrayBuffer()), path: new URL(request.url).pathname, query: new URL(request.url).search, headers: request.headers }
  if (mode === "gzip") return new Response(gzipSync("compressed reply"), { headers: { "content-encoding": "gzip" } })
  if (mode === "failure") return new Response("upstream error", { status: 429, headers: { "retry-after": "3" } })
  if (mode === "stream") return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode("first\n")) },
    cancel() { canceled = true },
  }), { headers: { "content-type": "text/event-stream" } })
  return new Response(observed.bytes)
} })
const manager = createBillingTransport()
const token = manager.register(`http://127.0.0.1:${upstream.port}`)
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, maxRequestBodySize: BILLING_BODY_LIMIT,
  fetch: request => manager.handle(request) })
const base = `http://127.0.0.1:${server.port}${BILLING_PREFIX}${token}`
const payload = JSON.stringify({ model: "claude-sonnet-4-6", messages: [{ role: "user", content: "hello" }] })
const options = { method: "POST", headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.322 (cli)" }, body: payload }
let checks = 0
function check(name, actual, expected) { assert.deepEqual(actual, expected, name); checks++ }
try {
  const gzip = await fetch(base + "/v1/messages", options)
  check("gzip response decoded once", await gzip.text(), "compressed reply")
  check("decoded response has no stale encoding", gzip.headers.get("content-encoding"), null)
  mode = "failure"
  const failure = await fetch(base + "/v1/messages", options)
  check("upstream failure status retained", failure.status, 429)
  check("upstream retry hint retained", failure.headers.get("retry-after"), "3")
  check("upstream error body retained", await failure.text(), "upstream error")
  mode = "echo"
  for (const ending of ["/v1", "/v1/messages", "/v1/"]) {
    const alias = manager.register(`http://127.0.0.1:${upstream.port}/vendor${ending}`)
    await fetch(`http://127.0.0.1:${server.port}${BILLING_PREFIX}${alias}/v1/messages`, options)
    check(`native Anthropic base normalization ${ending}`, observed.path, "/vendor/v1/messages")
  }
  await fetch(base + "/v1/messages?trace=synthetic", { ...options, headers: { ...options.headers, "content-type": "text/plain" } })
  check("non JSON bytes kept", new TextDecoder().decode(observed.bytes), payload)
  check("query preserved", observed.query, "?trace=synthetic")
  const compressed = gzipSync(payload)
  await fetch(base + "/v1/messages", { ...options, headers: { ...options.headers, "content-encoding": "gzip" }, body: compressed })
  check("encoded request bytes kept", [...observed.bytes], [...compressed])
  manager.retireExcept(new Set())
  await fetch(base + "/v1/messages", options)
  check("retired route forwards without injection", new TextDecoder().decode(observed.bytes), payload)
  manager.register(`http://127.0.0.1:${upstream.port}`, token)
  mode = "stream"
  const controller = new AbortController()
  const stream = await fetch(base + "/v1/messages", { ...options, signal: controller.signal })
  const reader = stream.body.getReader()
  const first = await Promise.race([reader.read(), new Promise((_, reject) => setTimeout(() => reject(new Error("first stream chunk timed out")), 2000))])
  check("first stream chunk arrives without waiting for completion", new TextDecoder().decode(first.value), "first\n")
  controller.abort()
  await reader.cancel().catch(() => {})
  for (let i = 0; i < 20 && !canceled; i++) await Bun.sleep(50)
  check("client cancellation closes upstream stream", canceled, true)
  const oversized = await manager.handle(new Request(base + "/v1/messages", { ...options, headers: { ...options.headers, "content-length": String(BILLING_BODY_LIMIT + 1) } }))
  check("size limit gives 413", oversized.status, 413)
  upstream.stop(true)
  const unavailable = await fetch(base + "/v1/messages", options)
  check("unavailable upstream gives 502", unavailable.status, 502)
  check("generic error hides target", (await unavailable.text()).includes(String(upstream.port)), false)
  const nonClaude = payload.replace("claude-sonnet-4-6", "other-model")
  check("other model untouched", addBilling(nonClaude, "claude-cli/2.1.322 (cli)"), nonClaude)
  console.log(JSON.stringify({ checks, allPassed: true, liveConfigTouched: false }))
} finally { server.stop(true); upstream.stop(true) }

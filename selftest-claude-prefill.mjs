// Explicit refusals only: the real listener, synthetic loopback upstream.
import assert from "node:assert/strict"
import { createBillingTransport, BILLING_PREFIX } from "./claude-billing.mjs"

const refusal = JSON.stringify({ error: { message: "vx cc claude: This model does not support assistant message prefill. The conversation must end with a user message.", type: "invalid_request_error" }, type: "error" })
let mode = "reject-prefill", requests = []
const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async req => {
  const body = JSON.parse(await req.text())
  requests.push(body)
  const refused = mode !== "success" && (mode !== "reject-prefill" || body.messages.at(-1).role === "assistant")
  if (refused) return new Response(mode === "other" ? '{"error":{"message":"invalid tool results"}}' : mode === "large" ? refusal + " ".repeat(70000) : refusal,
    { status: 400, headers: { "content-type": "application/json", "x-error-probe": "kept" } })
  return Response.json(body)
} })
const manager = createBillingTransport()
const token = manager.register(`http://127.0.0.1:${upstream.port}`)
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: req => manager.handle(req) })
const url = `http://127.0.0.1:${server.port}${BILLING_PREFIX}${token}/v1/messages`
const original = { model: "claude-sonnet-4-6", stream: false, metadata: { user_id: "synthetic" },
  system: [{ type: "text", text: "caller system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: "initial prompt" }, { role: "assistant", content: [{ type: "text", text: "summary prefill", cache_control: { type: "ephemeral" } }] }] }
const send = async (body = original, ua = "claude-cli/2.1.322 (cli)") => {
  requests = []
  return fetch(url, { method: "POST", headers: { "content-type": "application/json", "user-agent": ua }, body: JSON.stringify(body) })
}
let checks = 0
const check = (name, actual, expected) => { assert.deepEqual(actual, expected, name); checks++ }
try {
  let reply = await send()
  check("explicit prefill refusal succeeds after retry", reply.status, 200)
  check("exactly one retry", requests.length, 2)
  const accepted = await reply.json()
  check("original messages preserved", accepted.messages.slice(0, -1), original.messages)
  check("native continuation appended", accepted.messages.at(-1), { role: "user", content: "Continue." })
  check("system cache preserved", accepted.system.slice(1), original.system)
  check("metadata preserved", accepted.metadata, original.metadata)
  check("billing stable between attempts", requests[0].system, requests[1].system)
  mode = "success"
  reply = await send()
  check("successful prefill is never rewritten", (await reply.json()).messages, original.messages)
  check("successful prefill sends once", requests.length, 1)
  for (const variant of ["other", "large", "always", "tool", "nonClaude", "userLast", "retired"]) {
    mode = ["other", "large"].includes(variant) ? variant : "always"
    let body = structuredClone(original), ua = "claude-cli/2.1.322 (cli)"
    if (variant === "tool") body.messages.at(-1).content.push({ type: "tool_use", id: "pending", name: "probe", input: {} })
    if (variant === "nonClaude") ua = "synthetic-caller"
    if (variant === "userLast") body.messages.push({ role: "user", content: "next" })
    if (variant === "retired") manager.retireExcept(new Set())
    reply = await send(body, ua)
    check(`${variant} retains refusal`, reply.status, 400)
    check(`${variant} retry count`, requests.length, variant === "always" ? 2 : 1)
    check(`${variant} response headers kept`, reply.headers.get("x-error-probe"), "kept")
    check(`${variant} response bytes kept`, await reply.text(), variant === "other" ? '{"error":{"message":"invalid tool results"}}' : variant === "large" ? refusal + " ".repeat(70000) : refusal)
  }
  console.log(JSON.stringify({ checks, allPassed: true, liveConfigTouched: false }))
} finally { server.stop(true); upstream.stop(true) }

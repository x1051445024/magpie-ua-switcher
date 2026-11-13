// Final Anthropic wire transport, shared by gateway turns and native model tests.
// No external dependencies; caller prompts never share the attribution block.
import { createHash, randomBytes } from "node:crypto"

export const BILLING_PREFIX = "/_ua_claude/"
export const BILLING_BODY_LIMIT = 64 * 1024 * 1024
const TOKEN_RE = /^[0-9a-f]{48}$/
const HOP_HEADERS = ["host", "connection", "content-length", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade"]

export function validBillingTarget(value) {
  try {
    const u = new URL(value)
    return ["http:", "https:"].includes(u.protocol) && !u.username && !u.password && !u.search && !u.hash && !u.pathname.includes(BILLING_PREFIX)
  } catch { return false }
}

export function billingUnavailable(provider, globalDirect) {
  if (["clientCert", "clientKey", "serverCA", "serverPin"].some(k => provider[k]) || provider.insecureTLS || provider.http1) return "自定义 TLS / HTTP 配置暂不支持"
  if (Object.values(provider.accountProxies ?? {}).some(v => v && v !== "direct")) return "单账号代理暂不支持"
  if (provider.proxy !== "direct" && !(globalDirect && !provider.proxy)) return "请将该供应商或 Magpie 全局代理设为直连；此功能暂不支持继承系统代理或自定义代理"
  return null
}

export function addBilling(raw, ua) {
  const version = /^claude-cli\/(\d+\.\d+\.\d+)(?=[\s+-]|$)/i.exec(ua ?? "")?.[1]
  if (!version) return raw
  let body
  try { body = JSON.parse(raw) } catch { return raw }
  if (!body || !Array.isArray(body.messages) || !/^claude(?:-|$)/i.test(body.model ?? "")) return raw
  const system = body.system
  if (typeof system === "string" && system.startsWith("x-anthropic-billing-header:")) return raw
  if (Array.isArray(system) && system.some(b => typeof b?.text === "string" && b.text.startsWith("x-anthropic-billing-header:"))) return raw
  if (system !== undefined && typeof system !== "string" && !Array.isArray(system)) return raw
  const content = body.messages.find(m => m?.role === "user")?.content
  const text = typeof content === "string" ? content : (Array.isArray(content) ? content.find(b => b?.type === "text")?.text : "") ?? ""
  if (typeof text !== "string") return raw
  // UTF-16 positions and UTF-8 encoding match the Claude Code attribution hash.
  const fp = createHash("sha256").update("59cf53e54c78" + (text[4] || "0") + (text[7] || "0") + (text[20] || "0") + version).digest("hex").slice(0, 3)
  const blocks = Array.isArray(system) ? system : typeof system === "string" && system ? [{ type: "text", text: system }] : []
  body.system = [{ type: "text", text: `x-anthropic-billing-header: cc_version=${version}.${fp}; cc_entrypoint=cli;` }, ...blocks]
  return JSON.stringify(body)
}

function withoutHopHeaders(input) {
  const h = new Headers(input)
  for (const name of (h.get("connection") ?? "").split(",")) if (name.trim()) h.delete(name.trim())
  for (const name of HOP_HEADERS) h.delete(name)
  return h
}

function userLast(raw, ua) {
  if (!/^claude-cli\/\d+\.\d+\.\d+(?=[\s+-]|$)/i.test(ua ?? "")) return null
  let body
  try { body = JSON.parse(raw) } catch { return null }
  if (!/^claude(?:-|$)/i.test(body?.model ?? "") || !Array.isArray(body.messages)) return null
  const last = body.messages.at(-1)
  if (last?.role !== "assistant") return null
  const content = last.content
  if (!(typeof content === "string" && content.length || Array.isArray(content) && content.length && content.every(b => b?.type === "text" && typeof b.text === "string"))) return null
  body.messages.push({ role: "user", content: "Continue." })
  return JSON.stringify(body)
}

async function inspectPrefillRefusal(response) {
  if (!response.body) return { response, refused: false }
  // Bound error inspection. Replay every consumed byte when it is not a
  // recognized refusal, including oversized or non-JSON error responses.
  const reader = response.body.getReader(), chunks = []
  let size = 0, ended = false
  while (size <= 16384) {
    const part = await reader.read()
    if (part.done) { ended = true; break }
    chunks.push(part.value)
    size += part.value.length
  }
  let refused = false
  if (ended && size <= 16384) {
    try {
      const bytes = new Uint8Array(size)
      let offset = 0
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
      const message = JSON.parse(new TextDecoder().decode(bytes))?.error?.message
      refused = typeof message === "string" && /does not support (?:assistant message )?prefill|requests ending with a model turn are not supported/i.test(message)
    } catch {}
  }
  if (refused) { await reader.cancel(); return { response, refused } }
  const replay = new ReadableStream({
    async pull(controller) {
      if (chunks.length) { controller.enqueue(chunks.shift()); return }
      if (ended) { controller.close(); return }
      try {
        const part = await reader.read()
        if (part.done) controller.close()
        else controller.enqueue(part.value)
      } catch (e) { controller.error(e) }
    },
    cancel: reason => reader.cancel(reason),
  })
  return { response: new Response(replay, { status: response.status, statusText: response.statusText, headers: response.headers }), refused }
}

export function createBillingTransport() {
  const routes = new Map()
  return {
    register(target, token) {
      if (!validBillingTarget(target)) throw new Error("无效的 Anthropic 上游地址")
      if (!TOKEN_RE.test(token ?? "")) token = randomBytes(24).toString("hex")
      // Match Magpie's native Anthropic base normalization before appending
      // /v1/messages. The URL ledger still retains the exact original value.
      const upstream = new URL(target)
      upstream.pathname = upstream.pathname.replace(/\/+$/, "")
      for (const suffix of ["/v1/messages", "/v1"]) {
        if (upstream.pathname.endsWith(suffix)) { upstream.pathname = upstream.pathname.slice(0, -suffix.length); break }
      }
      routes.set(token, { target: upstream.href, active: true, until: Infinity })
      return token
    },
    retireExcept(active) {
      const now = Date.now()
      for (const [token, r] of routes) {
        if (!active.has(token) && r.active) { r.active = false; r.until = now + 60000 }
        if (r.until < now) routes.delete(token)
      }
    },
    async handle(request) {
      const u = new URL(request.url)
      if (!u.pathname.startsWith(BILLING_PREFIX)) return null
      const fail = (status, message) => Response.json({ error: { type: "api_error", message } }, { status })
      if (request.headers.has("origin") || request.headers.has("sec-fetch-site")) return fail(403, "Browser requests are not accepted on this transport.")
      const match = /^\/_ua_claude\/([0-9a-f]{48})(\/.*)$/.exec(u.pathname)
      const r = match && routes.get(match[1])
      if (!r || r.until < Date.now()) return fail(404, "Unknown Claude transport route.")
      const suffix = match[2]
      const allowed = request.method === "POST" && ["/v1/messages", "/v1/messages/count_tokens"].includes(suffix)
        || ["GET", "HEAD"].includes(request.method) && suffix === "/v1/models"
      if (!allowed) return fail(404, "Unknown Claude transport endpoint.")
      if (Number(request.headers.get("content-length")) > BILLING_BODY_LIMIT) return fail(413, "Claude transport request exceeds 64 MiB.")
      const destination = new URL(r.target)
      destination.pathname = destination.pathname.replace(/\/$/, "") + suffix
      destination.search = u.search
      const headers = withoutHopHeaders(request.headers)
      let body, inspectBody = null
      try {
        if (request.method === "POST") {
          const bytes = new Uint8Array(await request.arrayBuffer())
          if (bytes.length > BILLING_BODY_LIMIT) return fail(413, "Claude transport request exceeds 64 MiB.")
          body = bytes
          if (r.active && suffix === "/v1/messages" && /application\/json/i.test(headers.get("content-type") ?? "") && !headers.has("content-encoding")) {
            const text = new TextDecoder().decode(bytes)
            const modified = addBilling(text, headers.get("user-agent"))
            if (modified !== text) body = modified
            inspectBody = modified
          }
        }
        // An explicit empty proxy disables Bun's environment proxy. Direct mode
        // is required before changing native URLs, so both hops retain semantics.
        const send = outgoing => fetch(destination, { method: request.method, headers, body: outgoing, proxy: "", redirect: "manual", signal: request.signal })
        let response = await send(body)
        const retryBody = response.status === 400 && inspectBody ? userLast(inspectBody, headers.get("user-agent")) : null
        if (retryBody) {
          const inspected = await inspectPrefillRefusal(response)
          response = inspected.response
          if (inspected.refused) response = await send(retryBody) // Exactly once; never retry a generated response.
        }
        if (response.status >= 300 && response.status < 400) {
          await response.body?.cancel()
          return fail(502, "Claude transport does not follow upstream redirects.")
        }
        const output = withoutHopHeaders(response.headers)
        output.delete("content-encoding") // Bun fetch decodes the upstream stream.
        return new Response(response.body, { status: response.status, statusText: response.statusText, headers: output })
      } catch {
        return fail(502, "Claude transport upstream request failed.")
      }
    },
  }
}

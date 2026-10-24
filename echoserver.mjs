// A tiny upstream stand-in for ua-switcher's self-check: records the headers
// of every request to ua-echo-last.json (next to this file) and answers with
// a minimal Anthropic Messages response. Run with magpie's bundled Bun:
//   "C:\Users\Lenovo\.cache\magpie\bun\1.4.2\magpie-bun.exe" echoserver.mjs
import fs from "node:fs"
import path from "node:path"

const OUT = path.join(import.meta.dir, "ua-echo-last.json")
Bun.serve({
  hostname: "127.0.0.1",
  port: 3427,
  async fetch(req) {
    const headers = {}
    req.headers.forEach((v, k) => (headers[k] = v))
    let body = ""
    try {
      body = await req.text()
    } catch {}
    fs.writeFileSync(OUT, JSON.stringify({ url: req.url, method: req.method, headers, body }, null, 2))
    return Response.json({
      id: "msg_echo",
      type: "message",
      role: "assistant",
      model: "ua-echo/test",
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
    })
  },
})
console.error(`ua-echo listening on http://127.0.0.1:3427, recording to ${OUT}`)

// ua-switcher's gateway middleware (magpie.middleware): cleans the top level
// of Anthropic tool input schemas.
//
// Anthropic's Messages API rejects a tool schema whose top level carries
// oneOf / allOf / anyOf, and requires a top-level type. Some MCP servers
// express mutual exclusion with zod's .refine(), which lands exactly there
// ("input_schema does not support oneOf, allOf, or anyOf at the top level").
// GLM-style upstreams tolerate it; a real Anthropic endpoint does not.
//
// Only the top level is touched: nested unions are legal and stay as they are.
// Runs inside magpie (moejs, no Node APIs), 250ms per request; returning
// undefined leaves the request bytes untouched.
//
// Since 1.8.0 this is also where the tool-schema diagnostics live (they used
// to be in the gateway hook, hooks.mjs, which is gone): set the plugin's
// options to {"diagnose": true} — `magpie plugin options ua-switcher
// '{"diagnose":true}'`, or the Options button in Plugins › Installed — and
// each tool Anthropic would reject is named in magpie's log. Read-only: the
// request is never modified for it, and moejs has no file system, so it logs
// instead of writing ua-switcher-tools.json as the hook did.

const UNIONS = ["oneOf", "allOf", "anyOf"]

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// mergePropertyDefs reconciles two schema definitions for the same property name.
// If identical, keeps the first; if different, wraps in a property-level anyOf
// (which Anthropic's validator explicitly permits inside properties.<key>).
function mergePropertyDefs(existing, incoming) {
  if (!isObject(existing) || !isObject(incoming)) return existing
  let same = false
  try {
    same = JSON.stringify(existing) === JSON.stringify(incoming)
  } catch {}
  if (same) return existing
  if (Array.isArray(existing.anyOf)) {
    const incStr = JSON.stringify(incoming)
    for (let i = 0; i < existing.anyOf.length; i++) {
      if (JSON.stringify(existing.anyOf[i]) === incStr) return existing
    }
    return { anyOf: existing.anyOf.concat([incoming]) }
  }
  return { anyOf: [existing, incoming] }
}

// mergeProperties gathers properties across base schema and all union branches.
function mergeProperties(baseProps, branches) {
  const out = isObject(baseProps) ? { ...baseProps } : {}
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]
    if (!isObject(b) || !isObject(b.properties)) continue
    const keys = Object.keys(b.properties)
    for (let k = 0; k < keys.length; k++) {
      const name = keys[k]
      const propDef = b.properties[name]
      if (!Object.prototype.hasOwnProperty.call(out, name)) {
        out[name] = propDef
      } else {
        out[name] = mergePropertyDefs(out[name], propDef)
      }
    }
  }
  return out
}

// fixTool rewrites one tool's schema in place; true when anything changed.
function fixTool(tool) {
  if (!isObject(tool)) return false
  const schema = tool.input_schema !== undefined ? tool.input_schema : tool.parameters
  if (!isObject(schema)) return false
  let changed = false

  let branches = []
  let allOfBranches = []
  for (let i = 0; i < UNIONS.length; i++) {
    const key = UNIONS[i]
    if (Array.isArray(schema[key])) {
      if (key === "allOf") allOfBranches = allOfBranches.concat(schema[key])
      branches = branches.concat(schema[key])
      delete schema[key]
      changed = true
    }
  }

  if (branches.length) {
    const merged = mergeProperties(schema.properties, branches)
    if (Object.keys(merged).length || !isObject(schema.properties)) {
      schema.properties = merged
      changed = true
    }
    // Merge required fields from allOf branches if present
    if (allOfBranches.length) {
      const reqSet = Array.isArray(schema.required) ? schema.required.slice() : []
      for (let i = 0; i < allOfBranches.length; i++) {
        const bReq = allOfBranches[i] && allOfBranches[i].required
        if (Array.isArray(bReq)) {
          for (let r = 0; r < bReq.length; r++) {
            if (typeof bReq[r] === "string" && reqSet.indexOf(bReq[r]) === -1) reqSet.push(bReq[r])
          }
        }
      }
      if (reqSet.length) schema.required = reqSet
    }
  }

  if (schema.type === undefined || schema.type === null) {
    schema.type = "object"
    changed = true
  }
  if (!isObject(schema.properties)) {
    schema.properties = {}
    changed = true
  }

  // a required name with no property behind it is rejected too
  if (Array.isArray(schema.required)) {
    const kept = schema.required.filter(
      (name) => typeof name === "string" && Object.prototype.hasOwnProperty.call(schema.properties, name)
    )
    if (kept.length !== schema.required.length) {
      changed = true
      if (kept.length) schema.required = kept
      else delete schema.required
    }
  }

  if (changed) {
    tool.input_schema = schema
    if (tool.parameters !== undefined) delete tool.parameters
  }
  return changed
}

export function onRequest(body, ctx) {
  try {
    if (!isObject(body)) return
    if (!ctx || ctx.protocol !== "anthropic") return
    const options = isObject(ctx.options) ? ctx.options : {}
    if (options.diagnose === true) diagnose(body.tools)
    // escape hatch, set through `magpie plugin options`; moejs cannot read files
    if (options.disable === true) return
    if (!Array.isArray(body.tools)) return
    let changed = false
    for (let i = 0; i < body.tools.length; i++) {
      if (fixTool(body.tools[i])) changed = true
    }
    if (changed) return body
  } catch {
    return
  }
}

// what Anthropic's validator turns away: a union at the top level of a tool's
// input schema, or no top-level type at all. Reported before fixTool has
// merged it away, so the log names the server the tool came from.
function oddSchemas(tools) {
  const out = []
  if (!Array.isArray(tools)) return out
  for (let i = 0; i < tools.length; i++) {
    const t = tools[i]
    if (!isObject(t)) continue
    const s = isObject(t.input_schema) ? t.input_schema : isObject(t.inputSchema) ? t.inputSchema : isObject(t.parameters) ? t.parameters : null
    if (!s) continue
    const top = UNIONS.filter((k) => k in s)
    if (top.length || !("type" in s)) out.push(`${t.name ?? "?"}(${top.length ? top.join("/") : "no type"};${Object.keys(s).join(",")})`)
  }
  return out
}

// one line per shape, not per turn: a pooled runtime sees the same tools on
// every request of the session, and magpie caps a middleware at 60 log lines
// a minute. The remembered line is bounded too — the runtime lives as long as
// the gateway does, so a request with thousands of tools must not grow it.
let lastReported = ""
const MAX_REPORTED = 6

function diagnose(tools) {
  try {
    const odd = oddSchemas(tools)
    if (!odd.length) return
    const shown = odd.slice(0, MAX_REPORTED)
    const line = shown.join(" ") + (odd.length > shown.length ? ` +${odd.length - shown.length} more` : "")
    if (line === lastReported) return
    lastReported = line
    if (typeof console !== "undefined" && console && typeof console.warn === "function") {
      console.warn(`ua-switcher: ${odd.length} tool schema(s) Anthropic would reject: ${line}`)
    }
  } catch {
    // diagnostics never break a request
  }
}

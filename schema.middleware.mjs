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

const UNIONS = ["oneOf", "allOf", "anyOf"]

function isObject(v) {
  return !!v && typeof v === "object" && !Array.isArray(v)
}

// mergeProperties gathers the branches' properties (first wins) for a schema
// that was nothing but a union.
function mergeProperties(branches) {
  const out = {}
  for (let i = 0; i < branches.length; i++) {
    const b = branches[i]
    if (!isObject(b) || !isObject(b.properties)) continue
    const keys = Object.keys(b.properties)
    for (let k = 0; k < keys.length; k++) {
      const name = keys[k]
      if (!Object.prototype.hasOwnProperty.call(out, name)) out[name] = b.properties[name]
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
  for (let i = 0; i < UNIONS.length; i++) {
    const key = UNIONS[i]
    if (Array.isArray(schema[key])) {
      branches = branches.concat(schema[key])
      delete schema[key]
      changed = true
    }
  }

  if (!isObject(schema.properties) && branches.length) {
    const merged = mergeProperties(branches)
    if (Object.keys(merged).length) {
      schema.properties = merged
      changed = true
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
    const kept = schema.required.filter((name) => Object.prototype.hasOwnProperty.call(schema.properties, name))
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
  if (!isObject(body)) return
  if (!ctx || ctx.protocol !== "anthropic") return
  // escape hatch, set through `magpie plugin options`; moejs cannot read files
  if (isObject(ctx.options) && ctx.options.disable === true) return
  if (!Array.isArray(body.tools)) return

  let changed = false
  for (let i = 0; i < body.tools.length; i++) {
    if (fixTool(body.tools[i])) changed = true
  }
  if (!changed) return
  return body // must return: undefined would discard the fix
}

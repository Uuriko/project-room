// Structured MCP tools/call errors. Callers get unknown_tool, auth_required,
// or invalid_arguments instead of one fixed "Unknown tool or invalid arguments"
// string. The JSON-RPC code stays -32602 for schema problems and -32001 when
// a room tool is called with no identity bearer.

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);

export const MCP_AUTH_HINT = "mint one at POST /api/agent-identities";
export const MCP_AUTH_MESSAGE = "Room tools need Authorization: Bearer <identity secret>; mint one at POST /api/agent-identities";

export function closestToolName(name, names) {
  const target = typeof name === "string" ? name : "";
  let best = null;
  let bestScore = Infinity;
  for (const candidate of names) {
    const score = editDistance(target, candidate);
    if (score < bestScore || (score === bestScore && (best === null || candidate < best))) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

function editDistance(left, right) {
  const a = String(left);
  const b = String(right);
  if (a === b) return 0;
  const rows = a.length + 1;
  const cols = b.length + 1;
  const prev = new Array(cols);
  const next = new Array(cols);
  for (let col = 0; col < cols; col += 1) prev[col] = col;
  for (let row = 1; row < rows; row += 1) {
    next[0] = row;
    for (let col = 1; col < cols; col += 1) {
      const cost = a[row - 1] === b[col - 1] ? 0 : 1;
      next[col] = Math.min(next[col - 1] + 1, prev[col] + 1, prev[col - 1] + cost);
    }
    for (let col = 0; col < cols; col += 1) prev[col] = next[col];
  }
  return prev[cols - 1];
}

function fieldReason(schema, value, base64) {
  if (!schema || typeof schema !== "object") return null;
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : [];
  if (value === null) return types.includes("null") ? null : "wrong type";
  if (types.includes("string") || (!types.length && typeof value === "string")) {
    if (typeof value !== "string") return "wrong type";
    if (schema.maxLength !== undefined && value.length > schema.maxLength) return "too long";
    if (schema.minLength !== undefined && value.length < schema.minLength) return "too short";
    if (base64 && !canonicalBase64(value, schema.maxLength)) return "bad base64";
    if (schema.enum && !schema.enum.includes(value)) return `must be one of: ${schema.enum.join(", ")}`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return "bad format";
    return null;
  }
  if (types.includes("integer")) {
    if (!Number.isSafeInteger(value)) return "wrong type";
    if (schema.maximum !== undefined && value > schema.maximum) return "too large";
    if (schema.minimum !== undefined && value < schema.minimum) return "too small";
    return null;
  }
  if (types.includes("number")) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "wrong type";
    if (schema.exclusiveMinimum !== undefined && !(value > schema.exclusiveMinimum)) return "too small";
    if (schema.maximum !== undefined && value > schema.maximum) return "too large";
    if (schema.minimum !== undefined && value < schema.minimum) return "too small";
    return null;
  }
  if (types.includes("boolean")) return typeof value === "boolean" ? null : "wrong type";
  if (types.includes("array")) {
    if (!Array.isArray(value)) return "wrong type";
    if (schema.maxItems !== undefined && value.length > schema.maxItems) return "too long";
    if (schema.minItems !== undefined && value.length < schema.minItems) return "too short";
    return null;
  }
  if (types.includes("object")) return object(value) ? null : "wrong type";
  if (types.length) return "wrong type";
  return null;
}

function canonicalBase64(value, maxLength) {
  if (typeof value !== "string") return false;
  if (maxLength !== undefined && value.length > maxLength) return false;
  if (value.length % 4 !== 0) return false;
  if (value.length > 0 && !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) return false;
  return true;
}

// Returns null when the value matches the tool inputSchema, otherwise
// { missing, unexpected, invalid } with a short reason per invalid field.
export function diagnoseArguments(schema, args, { base64Fields = [] } = {}) {
  const required = Array.isArray(schema?.required) ? schema.required : [];
  const props = object(schema?.properties) ? schema.properties : {};
  if (!object(args)) {
    return { missing: [...required], unexpected: [], invalid: { arguments: "must be an object" } };
  }
  const missing = required.filter(key => !Object.hasOwn(args, key));
  const unexpected = schema?.additionalProperties === false
    ? Object.keys(args).filter(key => !Object.hasOwn(props, key))
    : [];
  const invalid = {};
  for (const [key, value] of Object.entries(args)) {
    if (!Object.hasOwn(props, key)) continue;
    const reason = fieldReason(props[key], value, base64Fields.includes(key));
    if (reason) invalid[key] = reason;
  }
  if (!missing.length && !unexpected.length && !Object.keys(invalid).length) return null;
  return { missing, unexpected, invalid };
}

export function mcpCallError(id, { reason, tool, suggestion = null, missing = [], unexpected = [], invalid = {}, hint = null } = {}) {
  if (reason === "auth_required") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32001,
        message: MCP_AUTH_MESSAGE,
        data: { reason: "auth_required", tool: tool ?? null, hint: hint || MCP_AUTH_HINT }
      }
    };
  }
  if (reason === "unknown_tool") {
    return {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32602,
        message: "unknown_tool",
        data: { reason: "unknown_tool", tool: tool ?? null, suggestion }
      }
    };
  }
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: -32602,
      message: "invalid_arguments",
      data: { reason: "invalid_arguments", tool: tool ?? null, missing, unexpected, invalid }
    }
  };
}

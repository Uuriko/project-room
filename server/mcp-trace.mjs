// MCP trace schema v1 (S1, MEASUREMENT-PLAN row S1 / DISPOSITIONS 10-1).
//
// Step 0 of the C07-A stateless-MCP migration: before the migration moves
// the /mcp surface, every tools/call dispatch emits ONE structured trace
// row so that, after 14 days, the error_class x tool table exists, the
// golden set's error coverage (>=80%) is checkable against real traffic,
// and BUSY-500 per tool per day is countable.
//
// A trace row records, per tool call, ONLY:
//   tool        — the canonical tool name (never a caller-supplied string
//                 that fails the tool-name shape; those record as
//                 "<invalid>"),
//   error_class — one closed class (see MCP_TRACE_ERROR_CLASSES, plus the
//                 http_<status> family for tool-result errors),
//   args_shape  — the SHAPE of the arguments: sorted top-level key names
//                 with the type of each value ("roomId:string,limit:number").
//                 Argument VALUES are never read into the row — secrets are
//                 excluded by construction, not by redaction. Nested
//                 values record only as "object"/"array": no nested keys,
//                 no lengths, no contents.
// plus the bookkeeping fields event / v / ts / day that make rows
// greppable and day-bucketable in the server log.
//
// Emission is in-handler logging (ruling XW1: no gateway): the /mcp
// handler funnel (dispatchRoomMcp in server/mcp-http.mjs, used by both
// the Node and fetch transports) emits via emitMcpTrace, and the
// room_run_action recursion in server/mcp-room-profile.mjs emits for the
// inner dispatch. This module is deliberately NOT a counter and creates
// no store table: the per-tool daily call/error counts are PR #4984's
// mcp_tool_calls table (server/mcp-tool-calls.mjs, open at filing time);
// the trace complements it with the per-call error_class and args_shape
// dimensions the counter does not carry. Rows are log lines
// (console.info, one JSON object per line, event "mcp.trace"), the same
// structured-log shape as room.identity_scrypt / room.escrow_epochs.
//
// Versioning rule: MCP_TRACE_SCHEMA_VERSION bumps on ANY change to the
// row's field set, a field's meaning, the error_class taxonomy, or the
// args_shape encoding. The artefact spec/mcp-trace-schema-v1.json mirrors
// the schema below and tests/mcp-trace-schema.test.js pins both — a shape
// change without a version bump fails the pin.

export const MCP_TRACE_SCHEMA_VERSION = 1;

export const MCP_TRACE_EVENT = "mcp.trace";

// The closed base taxonomy. Tool-result errors carrying an integer HTTP
// status and no more specific class record as `http_<status>` (pattern
// ^http_[45]\d\d$ in the artefact) so new tool codes never need a schema
// change to be counted; every other class is one of these literals.
export const MCP_TRACE_ERROR_CLASSES = Object.freeze([
  "ok",
  "unknown_tool",
  "auth_required",
  "invalid_arguments",
  "insufficient_scope",
  "busy_500",
  "tool_error",
  "transport_error",
]);

export const MCP_TRACE_SCHEMA = Object.freeze({
  version: 1,
  event: "mcp.trace",
  fields: Object.freeze({
    event: "string, always \"mcp.trace\"",
    v: "number, the schema version (1)",
    ts: "string, ISO 8601 timestamp of the dispatch",
    day: "string, UTC calendar day of ts (YYYY-MM-DD)",
    tool: "string, canonical tool name, or \"<invalid>\"",
    error_class: "string, one of MCP_TRACE_ERROR_CLASSES or http_<status>",
    args_shape: "string, sorted \"key:type\" pairs joined by \",\"; empty string for no arguments",
  }),
  error_classes: MCP_TRACE_ERROR_CLASSES,
  error_class_pattern: "^http_[45][0-9][0-9]$",
  args_shape_types: Object.freeze(["array", "boolean", "null", "number", "object", "string", "undefined"]),
  versioning_rule: "Bump the version on ANY change to the field set, a field's meaning, the error_class taxonomy, or the args_shape encoding. A shape change without a version bump fails tests/mcp-trace-schema.test.js.",
});

// Non-enumerable carrier for a classification only the throwing site can
// know: server/mcp-room-profile.mjs tags its failure reply when the thrown
// error was SQLite BUSY / storage-unavailable, because failureValue maps
// that error to a generic {status:500, code:"internal"} and the BUSY
// signal would otherwise be lost before the /mcp handler emits. A Symbol
// property never serialises into the JSON-RPC reply.
export const MCP_TRACE_ERROR_CLASS = Symbol("mcpTraceErrorClass");

export function tagMcpTraceErrorClass(reply, errorClass) {
  if (!reply || typeof reply !== "object" || typeof errorClass !== "string") return reply;
  try {
    Object.defineProperty(reply, MCP_TRACE_ERROR_CLASS, { value: errorClass, configurable: true });
  } catch { /* an untaggable reply just classifies from its shape */ }
  return reply;
}

// The BUSY predicate mirrors server/store.mjs isStorageUnavailable /
// isOperationalIntegrityError: SQLITE_BUSY (errcode low byte 5), the
// storage_unavailable / SQLITE_BUSY codes, and the "database is locked"
// message. These are the failures that surface as 500-class at the door.
export function isBusyMcpError(error) {
  if (!error) return false;
  if (error.code === "SQLITE_BUSY" || error.code === "storage_unavailable") return true;
  if (Number.isInteger(error.errcode) && (error.errcode & 0xff) === 5) return true;
  return /database is locked/i.test(String(error.message ?? error ?? ""));
}

const TOOL_NAME_RE = /^[A-Za-z0-9_.\-]{1,128}$/;

export function traceToolName(name) {
  return typeof name === "string" && TOOL_NAME_RE.test(name) ? name : "<invalid>";
}

function valueType(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value; // string | number | boolean | object | undefined | ...
}

// args_shape: sorted top-level "key:type" pairs. Keys are capped at 64
// entries and 64 chars each so a hostile argument object cannot make an
// unbounded log line; values contribute their type ONLY.
export function argsShape(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) return "";
  return Object.keys(args).sort().slice(0, 64)
    .map(key => `${key.slice(0, 64)}:${valueType(args[key])}`)
    .join(",");
}

// Classify one settled dispatch. `thrown` is an error that escaped the
// dispatch (the transports convert it to a transport 500); `reply` is the
// JSON-RPC reply object when one exists.
export function classifyMcpTrace({ reply = null, thrown = null } = {}) {
  const tagged = reply?.[MCP_TRACE_ERROR_CLASS];
  if (typeof tagged === "string" && tagged) return tagged;
  if (thrown) return isBusyMcpError(thrown) ? "busy_500" : "transport_error";
  if (!reply || typeof reply !== "object") return "transport_error";
  if (reply.error && typeof reply.error === "object") {
    const reason = reply.error.data?.reason;
    if (reason === "auth_required" || reply.error.code === -32001) return "auth_required";
    if (reason === "unknown_tool") return "unknown_tool";
    if (reason === "invalid_arguments" || reason === "invalid_request" || reason === "invalid_json") return "invalid_arguments";
    if (reason === "insufficient_scope") return "insufficient_scope";
    return "transport_error";
  }
  const result = reply.result;
  if (result && typeof result === "object" && result.isError === true) {
    const value = result.structuredContent;
    const code = value && typeof value === "object" ? value.code : undefined;
    if (code === "insufficient_scope") return "insufficient_scope";
    const status = value && typeof value === "object" ? value.status : undefined;
    if (Number.isInteger(status) && status >= 400 && status <= 599) return `http_${status}`;
    return "tool_error";
  }
  return "ok";
}

// Build one v1 trace row. Returns null for anything that is not a
// tools/call dispatch — only tool calls are traced in v1.
export function buildMcpTrace({ tool, args, reply = null, thrown = null, at = Date.now() } = {}) {
  const ts = new Date(Number.isFinite(at) ? at : Date.now());
  return {
    event: MCP_TRACE_EVENT,
    v: MCP_TRACE_SCHEMA_VERSION,
    ts: ts.toISOString(),
    day: ts.toISOString().slice(0, 10),
    tool: traceToolName(tool),
    error_class: classifyMcpTrace({ reply, thrown }),
    args_shape: argsShape(args),
  };
}

// Emit one trace row as a structured log line. Never throws: tracing
// rides the MCP dispatch path and must not be able to fail a tool call.
export function emitMcpTrace(input, log = console.info) {
  try {
    const row = buildMcpTrace(input);
    log(JSON.stringify(row));
    return row;
  } catch {
    return null;
  }
}

// Convenience for a JSON-RPC message + its settled reply: extracts the
// tool name and arguments from a tools/call message and emits. Returns
// null (and emits nothing) for any other method.
export function traceMcpToolCall(message, { reply = null, thrown = null, at = Date.now(), canonicalName = null, log } = {}) {
  if (!message || message.method !== "tools/call") return null;
  return emitMcpTrace({
    tool: canonicalName ?? message.params?.name,
    args: message.params?.arguments ?? {},
    reply, thrown, at,
  }, log);
}

// MCP trace schema v1 (S1): pin + shape + canary + in-handler emission.
//
// Failing-first at the base tip: server/mcp-trace.mjs and
// spec/mcp-trace-schema-v1.json do not exist there and dispatchRoomMcp
// emits no mcp.trace line, so every test here fails at the tip and passes
// at this PR's head.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  MCP_TRACE_SCHEMA, MCP_TRACE_SCHEMA_VERSION, MCP_TRACE_ERROR_CLASSES,
  argsShape, buildMcpTrace, classifyMcpTrace, emitMcpTrace, tagMcpTraceErrorClass, isBusyMcpError,
} from "../server/mcp-trace.mjs";
import { dispatchRoomMcp, handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { mcpCallError } from "../server/mcp-arg-errors.mjs";
import { RoomStore } from "../server/store.mjs";

const CANARY = "canary-secret-value-7f3a9d2e-do-not-record";

function captureTraces(fn) {
  const lines = [];
  const original = console.info;
  console.info = (...args) => { lines.push(args.join(" ")); };
  return Promise.resolve()
    .then(fn)
    .finally(() => { console.info = original; })
    .then(result => ({
      result,
      traces: lines
        .map(line => { try { return JSON.parse(line); } catch { return null; } })
        .filter(row => row && row.event === "mcp.trace"),
      raw: lines,
    }));
}

// ------------------------------------------------------------------ pin

test("schema pin: version, field set, and taxonomy are exactly v1", () => {
  assert.equal(MCP_TRACE_SCHEMA_VERSION, 1);
  assert.deepEqual(Object.keys(MCP_TRACE_SCHEMA.fields).sort(), [
    "args_shape", "day", "error_class", "event", "tool", "ts", "v",
  ]);
  assert.deepEqual([...MCP_TRACE_ERROR_CLASSES], [
    "ok", "unknown_tool", "auth_required", "invalid_arguments",
    "insufficient_scope", "busy_500", "tool_error", "transport_error",
  ]);
});

test("schema artefact spec/mcp-trace-schema-v1.json mirrors the code schema", () => {
  const artefact = JSON.parse(readFileSync(new URL("../spec/mcp-trace-schema-v1.json", import.meta.url), "utf8"));
  assert.equal(artefact.version, MCP_TRACE_SCHEMA.version);
  assert.equal(artefact.event, MCP_TRACE_SCHEMA.event);
  assert.deepEqual(artefact.fields, MCP_TRACE_SCHEMA.fields);
  assert.deepEqual(artefact.error_classes, [...MCP_TRACE_SCHEMA.error_classes]);
  assert.equal(artefact.error_class_pattern, MCP_TRACE_SCHEMA.error_class_pattern);
  assert.deepEqual(artefact.args_shape_types, [...MCP_TRACE_SCHEMA.args_shape_types]);
  assert.equal(artefact.versioning_rule, MCP_TRACE_SCHEMA.versioning_rule);
});

test("a built trace row carries exactly the v1 fields", () => {
  const row = buildMcpTrace({
    tool: "room_check_access",
    args: { roomId: "commons", limit: 3 },
    reply: { jsonrpc: "2.0", id: 1, result: { content: [] } },
    at: Date.UTC(2026, 9, 27, 12, 0, 0),
  });
  assert.deepEqual(Object.keys(row).sort(), [
    "args_shape", "day", "error_class", "event", "tool", "ts", "v",
  ]);
  assert.equal(row.event, "mcp.trace");
  assert.equal(row.v, 1);
  assert.equal(row.ts, "2026-10-27T12:00:00.000Z");
  assert.equal(row.day, "2026-10-27");
  assert.equal(row.tool, "room_check_access");
  assert.equal(row.error_class, "ok");
  assert.equal(row.args_shape, "limit:number,roomId:string");
});

// ------------------------------------------------------------- args_shape

test("args_shape records key names and value types only, sorted", () => {
  assert.equal(argsShape({}), "");
  assert.equal(argsShape(null), "");
  assert.equal(
    argsShape({ z: [1, 2], a: "text", m: { nested: true }, n: null, b: false }),
    "a:string,b:boolean,m:object,n:null,z:array",
  );
});

test("canary: a secret argument VALUE appears nowhere in the emitted trace", () => {
  const lines = [];
  const row = emitMcpTrace({
    tool: "room_post_message",
    args: {
      roomId: "commons",
      body: CANARY,
      nested: { token: CANARY },
      list: [CANARY],
    },
    reply: { jsonrpc: "2.0", id: 1, result: { content: [] } },
  }, line => lines.push(line));
  assert.equal(lines.length, 1);
  assert.ok(!lines[0].includes(CANARY), "canary value must not appear in the trace line");
  assert.ok(!JSON.stringify(row).includes(CANARY), "canary value must not appear in the trace row");
  // Only the top-level shape survives: key names + types, no nested keys.
  assert.equal(row.args_shape, "body:string,list:array,nested:object,roomId:string");
  assert.ok(!lines[0].includes("token"), "nested key names are not recorded either");
});

test("canary: a caller string that is not a tool name cannot leak via the tool field", () => {
  // A string with characters no tool name may contain (spaces) records as
  // "<invalid>", never verbatim. (A legal-shaped unknown name IS recorded:
  // the unknown_tool row of the error_class x tool table needs it.)
  const row = buildMcpTrace({ tool: `not a tool ${CANARY}`, args: {}, reply: null, thrown: new Error("boom") });
  assert.equal(row.tool, "<invalid>");
  assert.ok(!JSON.stringify(row).includes(CANARY));
});

// ------------------------------------------------------------- classify

test("classify: JSON-RPC call errors map to their reason classes", () => {
  const unknown = mcpCallError(1, { reason: "unknown_tool", tool: "nope" });
  assert.equal(classifyMcpTrace({ reply: unknown }), "unknown_tool");
  const auth = mcpCallError(1, { reason: "auth_required", tool: "room_post_message" });
  assert.equal(classifyMcpTrace({ reply: auth }), "auth_required");
  const invalid = mcpCallError(1, { reason: "invalid_arguments", tool: "x", missing: ["a"] });
  assert.equal(classifyMcpTrace({ reply: invalid }), "invalid_arguments");
});

test("classify: tool-result errors map to http_<status>, busy stays busy_500", () => {
  const fiveHundred = { jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: { status: 500, code: "internal" } } };
  assert.equal(classifyMcpTrace({ reply: fiveHundred }), "http_500");
  const notFound = { jsonrpc: "2.0", id: 1, result: { isError: true, structuredContent: { status: 404, code: "unknown_room" } } };
  assert.equal(classifyMcpTrace({ reply: notFound }), "http_404");
  // The throwing site tags the reply: a BUSY failure that failureValue
  // flattened to {status:500, code:"internal"} still counts as busy_500,
  // so BUSY-500/tool/day is countable, not just 500/tool/day.
  const tagged = tagMcpTraceErrorClass({ ...fiveHundred, result: { ...fiveHundred.result } }, "busy_500");
  assert.equal(classifyMcpTrace({ reply: tagged }), "busy_500");
  assert.ok(!JSON.stringify(tagged).includes("busy_500"), "the tag never serialises into the reply");
  assert.equal(classifyMcpTrace({ thrown: Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }) }), "busy_500");
  assert.equal(isBusyMcpError(Object.assign(new Error("x"), { errcode: 5 })), true);
  assert.equal(isBusyMcpError(new Error("plain failure")), false);
});

// ---------------------------------------------------- in-handler emission

test("/mcp handler emits one v1 trace per anonymous join tools/call", async () => {
  const { result, traces } = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "room_join_packet", arguments: {} } },
    {},
  ));
  assert.ok(result.result, "join call still succeeds");
  assert.equal(traces.length, 1);
  assert.equal(traces[0].tool, "room_join_packet");
  assert.equal(traces[0].error_class, "ok");
  assert.equal(traces[0].args_shape, "");
  assert.equal(traces[0].v, 1);
});

test("/mcp handler traces unknown and invalid join calls with their classes", async () => {
  const unknown = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_nope_nope", arguments: {} } }, {},
  ));
  assert.equal(unknown.traces.length, 1);
  assert.equal(unknown.traces[0].error_class, "unknown_tool");

  const invalid = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "room_join_packet", arguments: { note: CANARY } } }, {},
  ));
  assert.equal(invalid.traces.length, 1);
  assert.equal(invalid.traces[0].error_class, "invalid_arguments");
  assert.equal(invalid.traces[0].args_shape, "note:string");
  assert.ok(!invalid.raw.join("\n").includes(CANARY), "canary value must not appear in any emitted line");
});

test("/mcp handler emits nothing for non-tools/call methods", async () => {
  const { traces } = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 3, method: "tools/list" }, {},
  ));
  assert.equal(traces.length, 0);
  const direct = handleMcpJoinRpc({ jsonrpc: "2.0", id: 4, method: "tools/list" }, {});
  assert.ok(direct.result, "the pure join handler still works standalone");
});

test("/mcp handler traces the authenticated hosted path and mint through the same funnel", async t => {
  // In-memory store: same RoomStore code path (mint + authed dispatch are
  // real), without depending on on-disk WAL in the test environment.
  const store = new RoomStore(":memory:");
  t.after(() => { store.close(); });
  const hosted = createHostedRoomMcp(store);

  const mint = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "room_identity_mint", arguments: { displayName: "Trace Tester" } } },
    { roomMcp: hosted },
  ));
  const secret = mint.result?.result?.structuredContent?.secret;
  assert.equal(typeof secret, "string", "mint returns a secret to authenticate with");
  assert.equal(mint.traces.length, 1);
  assert.equal(mint.traces[0].tool, "room_identity_mint");
  assert.equal(mint.traces[0].error_class, "ok");
  assert.equal(mint.traces[0].args_shape, "displayName:string");
  assert.ok(!mint.raw.join("\n").includes(secret), "the minted secret never appears in a trace line");

  const check = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "room_check_access", arguments: {} } },
    { authorization: `Bearer ${secret}`, roomMcp: hosted },
  ));
  assert.equal(check.result?.result?.structuredContent?.status, "credential_accepted");
  assert.equal(check.traces.length, 1);
  assert.equal(check.traces[0].tool, "room_check_access");
  assert.equal(check.traces[0].error_class, "ok");

  const denied = await captureTraces(() => dispatchRoomMcp(
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "room_check_access", arguments: {} } },
    { roomMcp: hosted },
  ));
  assert.equal(denied.traces.length, 1);
  assert.equal(denied.traces[0].error_class, "auth_required");
});

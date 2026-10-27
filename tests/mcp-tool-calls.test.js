// MCP per-tool counter (deep-pass T0 usage-reads, Read 2): one counter
// write per tools/call at the two T0 dispatch points — callRoomTool
// (hosted, including the inner dispatch of a room_run_action recursion)
// and the anonymous join-tool branch in mcp-http.mjs. The 30-day per-tool
// clock reads these rows through the operator surface; these tests pin
// that the counters move exactly once per dispatch, errors included.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms, agentRoomSchema } from "../server/agent-rooms.mjs";
import { createHostedRoomMcp } from "../server/mcp-room-profile.mjs";
import { dispatchRoomMcp, handleMcpJoinRpc } from "../server/mcp-http.mjs";
import { listMcpToolCalls, recordMcpToolCall, verifyMcpToolCallsSchema } from "../server/mcp-tool-calls.mjs";

function setup(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-mcp-tool-calls-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  store.db.exec(agentRoomSchema);
  const rooms = new AgentRooms(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, rooms };
}

const rpc = (method, params) => ({ jsonrpc: "2.0", id: "c", method, ...(params === undefined ? {} : { params }) });
const today = () => new Date().toISOString().slice(0, 10);
const rowFor = (store, tool) => listMcpToolCalls(store.db, { day: today() }).find(row => row.tool === tool);

test("recordMcpToolCall upserts per (day, tool) and the schema verifies present or absent", (t) => {
  const { store } = setup(t);
  assert.deepEqual(verifyMcpToolCallsSchema(store.db, { allowAbsent: true }), { present: false });
  assert.deepEqual(listMcpToolCalls(store.db), []);
  assert.equal(recordMcpToolCall(store.db, "room_post_message", { at: Date.parse("2026-10-26T01:00:00Z") }), true);
  assert.equal(recordMcpToolCall(store.db, "room_post_message", { isError: true, at: Date.parse("2026-10-26T02:00:00Z") }), true);
  assert.equal(recordMcpToolCall(store.db, "room_post_message", { at: Date.parse("2026-10-27T01:00:00Z") }), true);
  assert.deepEqual(verifyMcpToolCallsSchema(store.db, { allowAbsent: true }), { present: true });
  assert.deepEqual(listMcpToolCalls(store.db), [
    { day: "2026-10-26", tool: "room_post_message", calls: 2, errors: 1 },
    { day: "2026-10-27", tool: "room_post_message", calls: 1, errors: 0 }
  ]);
  assert.equal(recordMcpToolCall(store.db, ""), false);
  assert.equal(recordMcpToolCall(null, "room_post_message"), false);
});

test("hosted call increments its tool row once", async (t) => {
  const { store } = setup(t);
  const identity = store.identities.create("Counter agent");
  const mcp = createHostedRoomMcp(store);
  const reply = await mcp(rpc("tools/call", { name: "room_check_access", arguments: {} }),
    { authorization: `Bearer ${identity.secret}` });
  assert.equal(reply.result?.isError, undefined, JSON.stringify(reply).slice(0, 200));
  assert.deepEqual(rowFor(store, "room_check_access"), { day: today(), tool: "room_check_access", calls: 1, errors: 0 });
});

test("hosted error path increments errors, not just calls", async (t) => {
  const { store } = setup(t);
  const identity = store.identities.create("Counter agent");
  const mcp = createHostedRoomMcp(store);
  const reply = await mcp(rpc("tools/call", { name: "room_check_access", arguments: { roomId: "commons" } }),
    { authorization: `Bearer ${identity.secret}` });
  assert.equal(reply.result?.isError, true, JSON.stringify(reply).slice(0, 200));
  assert.deepEqual(rowFor(store, "room_check_access"), { day: today(), tool: "room_check_access", calls: 1, errors: 1 });
});

test("anonymous join-tool call increments through the mcp-http dispatch recorder", async (t) => {
  const { store } = setup(t);
  const onToolCall = (tool, isError) => recordMcpToolCall(store.db, tool, { isError });
  const ok = await dispatchRoomMcp(rpc("tools/call", { name: "room_join_packet", arguments: {} }), { onToolCall });
  assert.ok(ok.result, JSON.stringify(ok).slice(0, 200));
  assert.deepEqual(rowFor(store, "room_join_packet"), { day: today(), tool: "room_join_packet", calls: 1, errors: 0 });
  // A known join tool with invalid arguments is a dispatched call that
  // failed: it increments errors. An unknown name never dispatches and
  // creates no row.
  const bad = await dispatchRoomMcp(rpc("tools/call", { name: "room_join_packet", arguments: { token: "nope" } }), { onToolCall });
  assert.ok(bad.error, JSON.stringify(bad).slice(0, 200));
  assert.deepEqual(rowFor(store, "room_join_packet"), { day: today(), tool: "room_join_packet", calls: 2, errors: 1 });
  const unknown = await dispatchRoomMcp(rpc("tools/call", { name: "room_join_pakcet", arguments: {} }), { onToolCall });
  assert.ok(unknown.error);
  assert.equal(rowFor(store, "room_join_pakcet"), undefined);
});

test("handleMcpJoinRpc without a recorder still answers and counts nothing", () => {
  const reply = handleMcpJoinRpc(rpc("tools/call", { name: "room_join_packet", arguments: {} }));
  assert.ok(reply.result);
});

test("room_run_action recursion: inner tool counted once at its dispatch, outer counted once as its own row", async (t) => {
  const { store } = setup(t);
  const identity = store.identities.create("Counter agent");
  const mcp = createHostedRoomMcp(store);
  const reply = await mcp(rpc("tools/call", {
    name: "room_run_action",
    arguments: { name: "room_check_access", arguments: {} }
  }), { authorization: `Bearer ${identity.secret}` });
  assert.equal(reply.result?.isError, undefined, JSON.stringify(reply).slice(0, 300));
  // Exactly two rows, one call each: the inner dispatch is not double
  // counted, and the outer room_run_action call is not counted twice.
  assert.deepEqual(rowFor(store, "room_check_access"), { day: today(), tool: "room_check_access", calls: 1, errors: 0 });
  assert.deepEqual(rowFor(store, "room_run_action"), { day: today(), tool: "room_run_action", calls: 1, errors: 0 });
  assert.equal(listMcpToolCalls(store.db, { day: today() }).length, 2);
});

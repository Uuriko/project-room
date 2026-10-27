// UT2 04-02 F1/F1b/F4 (PR-3): the joiner side of access requests had no MCP
// verb at all, and the owner's decision note was silently dropped on
// approve. Production evidence (wave-2026-10-27-user-testing-2, lane 04-02):
// six by-name probes for a request-creation tool -> unknown_tool; status
// polling was REST-only; an executed MCP approve with note:"..." returned
// decisionNote: null (the approve branch of AccessRequests.decide never
// wrote decision_note — deny and the permission-upgrade review both do).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "mcp-access-request-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => {
    t.after(async () => {
      server.closeStreams(); server.closeAllConnections();
      await new Promise(done => server.close(done));
      store.close(); rmSync(directory, { recursive: true, force: true });
    });
    resolve({ origin: `http://127.0.0.1:${server.address().port}`, store, rooms });
  }));
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(secret ? { Authorization: `Bearer ${secret}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, isError: body.result?.isError === true };
}

test("a joiner creates and polls an access request over MCP; the owner's approve keeps its note", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Dana Moss");
  const room = rooms.create(owner.secret, { roomId: "joiner-den", title: "Joiner den", purpose: "Access requests over MCP", kind: "personal", displayName: "Dana Moss" });
  const joiner = store.identities.create("Kit Arden");
  const bystander = store.identities.create("Bo Park");

  const filed = await call(origin, "room_request_access", {
    roomId: room.roomId, requestedPermissions: ["accept_work", "complete_work"], note: "I can do the garden tasks"
  }, joiner.secret);
  assert.equal(filed.isError, false, JSON.stringify(filed.body));
  assert.equal(filed.value.status, "pending");
  assert.equal(typeof filed.value.requestId, "string");
  const requestId = filed.value.requestId;

  const polled = await call(origin, "room_access_request_status", { requestId }, joiner.secret);
  assert.equal(polled.isError, false, JSON.stringify(polled.body));
  assert.equal(polled.value.status, "pending");
  assert.deepEqual([...polled.value.requestedPermissions], ["accept_work", "complete_work"]);

  const snooped = await call(origin, "room_access_request_status", { requestId }, bystander.secret);
  assert.equal(snooped.isError, true, "only the requesting identity can read its request");
  assert.equal(snooped.value.code, "not_found");

  const pending = await call(origin, "room_list_access_requests", { roomId: room.roomId }, owner.secret);
  assert.equal(pending.isError, false, JSON.stringify(pending.body));
  assert.ok(pending.value.requests.some(request => request.requestId === requestId), "owner sees the MCP-filed request");

  const decided = await call(origin, "room_decide_access_request", {
    roomId: room.roomId, requestId, decision: "approve", note: "welcome aboard"
  }, owner.secret);
  assert.equal(decided.isError, false, JSON.stringify(decided.body));
  assert.equal(decided.value.decisionNote, "welcome aboard",
    "the owner's decision note must be recorded on an approve, not silently dropped (04-02 F4)");

  const after = await call(origin, "room_access_request_status", { requestId }, joiner.secret);
  assert.equal(after.value.status, "approved");
  assert.equal(after.value.decisionNote, "welcome aboard");

  const access = await call(origin, "room_check_access", { roomId: room.roomId }, joiner.secret);
  assert.equal(access.isError, false, JSON.stringify(access.body));
  assert.equal(access.value.status, "credential_accepted");
});

test("room_request_access is idempotent on requestId and validates permissions", async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Rae Lind");
  const room = rooms.create(owner.secret, { roomId: "retry-den", title: "Retry den", purpose: "Idempotent filing", kind: "personal", displayName: "Rae Lind" });
  const joiner = store.identities.create("Jo Fenn");

  const args = { roomId: room.roomId, requestedPermissions: ["steer"], requestId: "ut2-joiner-retry-1" };
  const first = await call(origin, "room_request_access", args, joiner.secret);
  assert.equal(first.isError, false, JSON.stringify(first.body));
  const retry = await call(origin, "room_request_access", args, joiner.secret);
  assert.equal(retry.isError, false, JSON.stringify(retry.body));
  assert.equal(retry.value.requestId, "ut2-joiner-retry-1");

  const pending = await call(origin, "room_list_access_requests", { roomId: room.roomId }, owner.secret);
  assert.equal(pending.value.requests.filter(request => request.requestId === "ut2-joiner-retry-1").length, 1,
    "a retry files exactly one request");

  const bogus = await call(origin, "room_request_access",
    { roomId: room.roomId, requestedPermissions: ["fly"] }, joiner.secret);
  assert.equal(bogus.isError, true, "unknown permissions are refused with the vocabulary");
});

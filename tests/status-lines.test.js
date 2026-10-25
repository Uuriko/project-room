// Status lines are a side table. Setting one replaces the row and does not
// append a room event. The flag defaults off.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { statusLinesEnabled } from "../server/member-status-lines.mjs";
import "../server/routes/status-lines.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";
import { EVENT_TYPES as T } from "../src/events.js";
import { setTier } from "../server/autonomy-tiers.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-status-lines-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, displayName) => {
    store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName, kind: "agent", permissions: [] } });
    setTier(store.db, "commons", memberId, "t2_standard", { updatedBy: "owner", nowMs: Date.now() });
  };
  add("agent", "Test agent");
  add("agent2", "Second agent");
  const agentKey = store.issueAccessKey("commons", "agent");
  const agent2Key = store.issueAccessKey("commons", "agent2");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { request, store, origin, ownerKey, agentKey, agent2Key };
}

function logSize(store, roomId = "commons") {
  return {
    sequence: store.room(roomId).sequence,
    events: store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE room_id=?").get(roomId).n,
    rows: store.db.prepare("SELECT COUNT(*) AS n FROM room_member_status WHERE room_id=?").get(roomId).n
  };
}

function mentionsStatus(store, roomId, text) {
  return store.db.prepare("SELECT body FROM events WHERE room_id=?").all(roomId)
    .some(row => row.body.includes(text) || row.body.includes("presence.status_set") || row.body.includes("member.status_updated"));
}

async function rpc(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent };
}

test("a status line replaces itself and stays out of the log", async t => {
  const previous = process.env.ROOM_STATUS_LINES;
  t.after(() => {
    if (previous === undefined) delete process.env.ROOM_STATUS_LINES;
    else process.env.ROOM_STATUS_LINES = previous;
  });
  delete process.env.ROOM_STATUS_LINES;
  assert.equal(statusLinesEnabled(), false);
  const { request, store, origin, agentKey, agent2Key } = await serve(t);
  const before = logSize(store);

  const blocked = await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "Reviewing the board" }
  });
  assert.equal(blocked.status, 404);
  assert.equal((await blocked.json()).error.code, "status_lines_disabled");
  assert.deepEqual(logSize(store), before);

  process.env.ROOM_STATUS_LINES = "1";
  assert.equal(statusLinesEnabled(), true);
  const open = await request("/api/rooms/commons/status-lines");
  assert.equal(open.status, 401);

  const set = await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "  Reviewing the board  " }
  });
  assert.equal(set.status, 200);
  const setBody = await set.json();
  assert.deepEqual(setBody, { command: "presence.status_set", text: "Reviewing the board" });
  assert.equal(mentionsStatus(store, "commons", "Reviewing the board"), false);
  assert.deepEqual(logSize(store), { ...before, rows: 1 });

  const listed = await (await request("/api/rooms/commons/status-lines", { token: agentKey })).json();
  assert.deepEqual(listed.lines, [{ displayName: "Test agent", text: "Reviewing the board" }]);

  const again = await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "On the board" }
  });
  assert.equal(again.status, 200);
  assert.equal((await again.json()).text, "On the board");
  assert.equal(logSize(store).rows, 1);
  assert.equal(logSize(store).sequence, before.sequence);

  const tooLong = await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "x".repeat(141) }
  });
  assert.equal(tooLong.status, 422);
  const broken = await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "one\ntwo" }
  });
  assert.equal(broken.status, 422);
  const foreign = await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "hijacked", memberId: "agent2" }
  });
  assert.equal(foreign.status, 422);
  const still = await (await request("/api/rooms/commons/status-lines", { token: agentKey })).json();
  assert.deepEqual(still.lines, [{ displayName: "Test agent", text: "On the board" }]);

  assert.equal((await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agent2Key, data: { text: "Watching the queue" }
  })).status, 200);
  const both = await (await request("/api/rooms/commons/status-lines", { token: agent2Key })).json();
  assert.deepEqual(both.lines, [
    { displayName: "Second agent", text: "Watching the queue" },
    { displayName: "Test agent", text: "On the board" }
  ]);
  assert.equal(JSON.stringify(both).includes("agent2"), false);

  assert.equal((await request("/api/rooms/commons/status-lines", {
    method: "POST", token: agentKey, data: { text: "   " }
  })).status, 200);
  const cleared = await (await request("/api/rooms/commons/status-lines", { token: agentKey })).json();
  assert.deepEqual(cleared.lines, [{ displayName: "Second agent", text: "Watching the queue" }]);
  assert.equal(logSize(store).sequence, before.sequence);
  assert.equal(logSize(store).events, before.events);

  const rooms = new AgentRooms(store);
  const nia = store.identities.create("Nia");
  rooms.create(nia.secret, {
    roomId: "status-room", title: "Status room", purpose: "A line under the header", kind: "personal", displayName: "Nia"
  });
  const roomBefore = logSize(store, "status-room");
  const called = await rpc(origin, "room_set_status", { roomId: "status-room", text: "Reading the room" }, nia.secret);
  assert.equal(called.body.result?.isError, undefined);
  assert.equal(called.value.text, "Reading the room");
  assert.equal(called.value.command, "presence.status_set");
  assert.equal(logSize(store, "status-room").sequence, roomBefore.sequence);
  assert.equal(mentionsStatus(store, "status-room", "Reading the room"), false);
  const key = store.issueAccessKey("status-room", nia.identityId);
  const header = await (await request("/api/rooms/status-room/status-lines", { token: key })).json();
  assert.deepEqual(header.lines, [{ displayName: "Nia", text: "Reading the room" }]);

  delete process.env.ROOM_STATUS_LINES;
  const refused = await rpc(origin, "room_set_status", { roomId: "status-room", text: "Should not land" }, nia.secret);
  assert.equal(refused.body.result.isError, true);
  const kept = await (await request("/api/rooms/status-room/status-lines", { token: key })).json();
  assert.equal(kept.error.code, "status_lines_disabled");
  assert.equal(store.db.prepare("SELECT text FROM room_member_status WHERE room_id=?").get("status-room").text, "Reading the room");
});

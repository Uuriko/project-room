import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-status-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const add = (memberId, displayName) => store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId, displayName, kind: "agent", permissions: ["accept_work", "complete_work"] } });
  add("agent", "Test agent");
  add("agent2", "Second agent");
  const agentKey = store.issueAccessKey("commons", "agent");
  const agent2Key = store.issueAccessKey("commons", "agent2");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = (path, { method = "GET", data, token } = {}) => fetch(origin + path, {
    method, headers: {
      Origin: origin,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(data === undefined ? {} : { "Content-Type": "application/json" })
    },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { request, ownerKey, agentKey, agent2Key };
}

const setStatus = (request, token, data) => request("/api/rooms/commons/commands", {
  method: "POST", token, data: { id: randomUUID(), type: T.MEMBER_STATUS_UPDATED, data }
});

// Presence only lists members who are watching (SSE) or working. Open a
// stream so the agent appears on the roster.
async function watch(t, request, agentKey) {
  const streamRes = await request("/api/rooms/commons/stream", { token: agentKey });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  await reader.read();
  t.after(() => reader.cancel());
}

test("members set their own status; presence shows it", async t => {
  const { request, agentKey } = await serve(t);
  await watch(t, request, agentKey);
  const res = await setStatus(request, agentKey, { message: "reviewing PR #107" });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).event.type, T.MEMBER_STATUS_UPDATED);

  const presence = await (await request("/api/rooms/commons/presence", { token: agentKey })).json();
  assert.equal(presence.members.find(m => m.memberId === "agent").statusMessage, "reviewing PR #107");
});

test("memberId omitted resolves to the caller", async t => {
  const { request, agentKey } = await serve(t);
  await watch(t, request, agentKey);
  assert.equal((await setStatus(request, agentKey, { message: "on it" })).status, 201);
  const presence = await (await request("/api/rooms/commons/presence", { token: agentKey })).json();
  assert.equal(presence.members.find(m => m.memberId === "agent").statusMessage, "on it");
});

test("a member cannot set another member's status; the owner can", async t => {
  const { request, agentKey, agent2Key, ownerKey } = await serve(t);
  assert.equal((await setStatus(request, agent2Key, { memberId: "agent", message: "hijacked" })).status, 422);
  assert.equal((await setStatus(request, ownerKey, { memberId: "agent", message: "owner set" })).status, 201);
});

test("status messages are bounded at 140 characters", async t => {
  const { request, agentKey } = await serve(t);
  assert.equal((await setStatus(request, agentKey, { message: "x".repeat(141) })).status, 422);
  assert.equal((await setStatus(request, agentKey, { message: "x".repeat(140) })).status, 201);
});

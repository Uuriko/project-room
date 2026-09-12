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
  const directory = mkdtempSync(join(tmpdir(), "room-presence-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.MEMBER_ADDED,
    data: { memberId: "agent", displayName: "Test agent", kind: "agent", permissions: ["accept_work", "complete_work"] } });
  store.command(ownerKey, "commons", { id: randomUUID(), type: T.WORK_PROPOSED, data: {
    workItemId: "presence-one", title: "Presence probe", definitionOfDone: "Seen on the roster",
    accountableMemberId: "agent", mode: "read"
  } });
  const agentKey = store.issueAccessKey("commons", "agent");
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
  return { store, request, ownerKey, agentKey };
}

const presenceOf = async (request, token) =>
  (await (await request("/api/rooms/commons/presence", { token })).json()).members;

test("presence shows session workers with their work items; idle members are absent", async t => {
  const { request, agentKey, ownerKey } = await serve(t);
  assert.deepEqual(await presenceOf(request, agentKey), []);
  const started = await request("/api/rooms/commons/work-sessions", { method: "POST", token: agentKey,
    data: { requestId: randomUUID(), workItemId: "presence-one", expectedRevision: 0, action: "set_status", status: "processing" } });
  assert.equal(started.status, 201);
  const members = await presenceOf(request, agentKey);
  assert.equal(members.length, 1);
  assert.equal(members[0].memberId, "agent");
  assert.equal(members[0].displayName, "Test agent");
  assert.equal(members[0].kind, "agent");
  assert.equal(members[0].watching, false);
  assert.equal(members[0].workingOn.length, 1);
  assert.equal(members[0].workingOn[0].workItemId, "presence-one");
  assert.equal(typeof members[0].workingOn[0].heartbeat_at, "string");
  // owner holds no session and watches nothing: not on the roster
  assert.ok(!members.some(m => m.memberId === "owner"));
  // strangers cannot read presence
  assert.equal((await request("/api/rooms/commons/presence")).status, 401);
  void ownerKey;
});

test("presence shows live SSE watchers", async t => {
  const { request, agentKey } = await serve(t);
  const streamRes = await request("/api/rooms/commons/stream", { token: agentKey });
  assert.equal(streamRes.status, 200);
  const reader = streamRes.body.getReader();
  await reader.read(); // wait until the server has registered the stream
  const members = await presenceOf(request, agentKey);
  const self = members.find(m => m.memberId === "agent");
  assert.ok(self, "streaming agent appears on the roster");
  assert.equal(self.watching, true);
  assert.deepEqual(self.workingOn, []);
  await reader.cancel();
});

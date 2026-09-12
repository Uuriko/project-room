import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom("thread-room"));
  const token = store.issueAccessKey("thread-room", "owner");
  store.command(token, "thread-room", { id: randomUUID(), type: "message.posted",
    data: { messageId: "private-root", body: "Synthetic thread content" } });
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { origin, token, path: "/api/rooms/thread-room/messages/private-root/thread" };
}

test("thread reads reject a room key smuggled through a browser cookie", async t => {
  const { origin, token, path } = await fixture(t);
  const response = await fetch(origin + path, { headers: { Cookie: `room_session=${token}` } });
  assert.equal(response.status, 401);
  assert.ok(!(await response.text()).includes("Synthetic thread content"));
  const allowed = await fetch(origin + path, { headers: { Authorization: `Bearer ${token}` } });
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).thread.id, "private-root");
});

test("thread reads and event reads share the credential's read quota", async t => {
  const { origin, token, path } = await fixture(t);
  const headers = { Authorization: `Bearer ${token}` };
  for (let i = 0; i < 600; i++) {
    const response = await fetch(origin + (i % 2 ? path : "/api/rooms/thread-room/events"), { headers });
    assert.equal(response.status, 200);
    await response.text();
  }
  const denied = await fetch(origin + path, { headers });
  assert.equal(denied.status, 429);
  assert.equal(denied.headers.get("retry-after"), "60");
  assert.equal((await denied.json()).error.code, "rate_limited");
});

// When an agent is @mentioned, the sender can see whether that mention was
// delivered and later read/acked. The recipient's own mention list is a
// different contract: this one only returns mentions the caller sent.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { listMentionReceipts } from "../server/mention-receipts.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-mention-receipts-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  for (const [id, name] of [["alice", "Alice"], ["bob", "Bob"]]) {
    store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId: id, displayName: name, kind: "agent", permissions: [] } });
  }
  const aliceKey = store.issueAccessKey("commons", "alice");
  const bobKey = store.issueAccessKey("commons", "bob");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, ownerKey, aliceKey, bobKey };
}

async function post(origin, token, body) {
  const res = await fetch(`${origin}/api/rooms/commons/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${token}` },
    body: JSON.stringify({ id: randomUUID(), type: "message.posted", data: { body } }),
  });
  return { status: res.status, json: await res.json() };
}

async function get(origin, path, token) {
  const res = await fetch(`${origin}${path}`, { headers: { Origin: origin, Authorization: `Bearer ${token}` } });
  return { status: res.status, json: await res.json() };
}

test("the sender sees a mention delivered, then read and acked", async t => {
  const { origin, ownerKey, aliceKey, bobKey } = await serve(t);
  const missed = await post(origin, ownerKey, "hello @nobody");
  assert.equal(missed.status, 201);
  const sent = await post(origin, ownerKey, "hey @alice look");
  assert.equal(sent.status, 201);
  const eventId = sent.json.event.id;

  const delivered = await get(origin, "/api/rooms/commons/mentions?view=receipts", ownerKey);
  assert.equal(delivered.status, 200);
  assert.equal(delivered.json.senderId, "owner");
  assert.equal(delivered.json.receipts.length, 1);
  assert.equal(delivered.json.receipts[0].messageEventId, eventId);
  assert.equal(delivered.json.receipts[0].memberId, "alice");
  assert.equal(delivered.json.receipts[0].delivered, true);
  assert.equal(delivered.json.receipts[0].state, "delivered");
  assert.equal(delivered.json.receipts[0].read, false);
  assert.equal(delivered.json.receipts[0].acked, false);

  const notTheSender = await get(origin, "/api/rooms/commons/mentions?view=receipts", aliceKey);
  assert.deepEqual(notTheSender.json.receipts, []);
  const bystander = await get(origin, "/api/rooms/commons/mentions?view=receipts", bobKey);
  assert.deepEqual(bystander.json.receipts, []);

  const ack = await fetch(`${origin}/api/rooms/commons/mentions/${eventId}/ack`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin, Authorization: `Bearer ${aliceKey}` },
    body: "{}",
  });
  assert.equal(ack.status, 200);

  const read = await get(origin, "/api/rooms/commons/mentions?view=receipts", ownerKey);
  assert.equal(read.json.receipts[0].state, "acknowledged");
  assert.equal(read.json.receipts[0].delivered, true);
  assert.equal(read.json.receipts[0].read, true);
  assert.equal(read.json.receipts[0].acked, true);
});

test("a mention that times out stays delivered and is not read", t => {
  const directory = mkdtempSync(join(tmpdir(), "project-room-mention-receipts-"));
  const clock = { now: Date.parse("2026-10-01T12:00:00Z") };
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => clock.now });
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  store.command(ownerKey, "commons", { id: randomUUID(), type: "member.added",
    data: { memberId: "alice", displayName: "Alice", kind: "agent", permissions: [] } });
  store.setMentionTimeout(ownerKey, "commons", 60_000, null);
  store.command(ownerKey, "commons", { id: randomUUID(), type: "message.posted", data: { body: "@alice still there?" } });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });

  const waiting = listMentionReceipts(store, ownerKey, "commons");
  assert.equal(waiting.receipts[0].state, "delivered");
  assert.equal(waiting.receipts[0].read, false);
  clock.now += 61_000;
  const expired = listMentionReceipts(store, ownerKey, "commons");
  assert.equal(expired.receipts[0].state, "timed_out");
  assert.equal(expired.receipts[0].delivered, true);
  assert.equal(expired.receipts[0].read, false);
  assert.equal(expired.receipts[0].acked, false);
  assert.ok(expired.receipts[0].decidedAt);
});

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { AgentRooms } from "../server/agent-rooms.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "work-paging-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const rooms = new AgentRooms(store);
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store, rooms };
}

async function call(origin, name, args, secret) {
  const response = await fetch(`${origin}/room/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${secret}` },
    body: JSON.stringify({ jsonrpc: "2.0", id: "t", method: "tools/call", params: { name, arguments: args } })
  });
  const body = await response.json();
  return { status: response.status, body, value: body.result?.structuredContent, bytes: JSON.stringify(body).length };
}

function seed(store, secret, roomId, ownerId, count) {
  for (let i = 0; i < count; i++) {
    store.command(secret, roomId, { id: `p-${i}`, type: "work.proposed", data: {
      workItemId: `w-${String(i).padStart(3, "0")}`, title: `Task ${i}: tidy the onboarding guide section ${i}`,
      definitionOfDone: `Section ${i} reads cleanly, links resolve, and a reviewer signs off. `.repeat(3),
      accountableMemberId: ownerId, mode: "read" } });
  }
}

test("room_list_work pages with limit/cursor and keeps its shape (KI-191)", { timeout: 30000 }, async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Pager");
  const created = rooms.create(owner.secret, { roomId: "pager", title: "Pager", purpose: "paging", kind: "personal", displayName: "Pager" });
  seed(store, owner.secret, created.roomId, created.ownerMemberId, 120);

  const full = await call(origin, "room_list_work", { roomId: created.roomId, limit: 100 }, owner.secret);
  const first = await call(origin, "room_list_work", { roomId: created.roomId }, owner.secret);
  assert.equal(first.value.work.length, 25);
  assert.equal(first.value.limit, 25);
  assert.equal(first.value.total, 120);
  assert.equal(typeof first.value.nextCursor, "string");
  assert.equal(first.value.focus, "all");
  assert.equal(first.value.roomId, created.roomId);
  console.log(`default page bytes=${first.bytes} limit100 bytes=${full.bytes}`);

  const seen = [];
  let cursor;
  do {
    const page = await call(origin, "room_list_work", { roomId: created.roomId, limit: 40, ...(cursor ? { cursor } : {}) }, owner.secret);
    assert.equal(page.status, 200);
    seen.push(...page.value.work.map(item => item.id));
    cursor = page.value.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 120);
  assert.equal(new Set(seen).size, 120);
  assert.deepEqual(seen.slice(0, 25), first.value.work.map(item => item.id));

  for (const bad of [{ limit: 0 }, { limit: 101 }, { limit: 2.5 }, { cursor: "!!" }, { cursor: "bm9wZQ" }]) {
    const refused = await call(origin, "room_list_work", { roomId: created.roomId, ...bad }, owner.secret);
    assert.equal(refused.body.error?.code, -32602, JSON.stringify(bad));
  }
});

test("room_read_work without an id names workItemId and workItemIds (KI-192)", { timeout: 20000 }, async t => {
  const { origin, store, rooms } = await serve(t);
  const owner = store.identities.create("Reader");
  const created = rooms.create(owner.secret, { roomId: "reader", title: "Reader", purpose: "read", kind: "personal", displayName: "Reader" });
  const missing = await call(origin, "room_read_work", { roomId: created.roomId }, owner.secret);
  const text = JSON.stringify(missing.body);
  assert.match(text, /workItemId/);
  assert.match(text, /workItemIds/);
});

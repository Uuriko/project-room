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
  const directory = mkdtempSync(join(tmpdir(), "project-room-thread-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = (body, replyToId = null) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body, ...(replyToId ? { replyToId } : {}) } }).event.data.messageId;
  return { origin, ownerKey, post };
}

test("threaded replies return the reply tree (round-2 #112)", async t => {
  const { origin, ownerKey, post } = await serve(t);
  const root = post("root");
  const reply1 = post("reply 1", root);
  post("reply 2", root);
  const nested = post("nested", reply1);
  const unrelated = post("unrelated");

  const res = await fetch(`${origin}/api/rooms/commons/messages/${root}/thread`, {
    headers: { Origin: origin, Authorization: `Bearer ${ownerKey}` }
  });
  assert.equal(res.status, 200);
  const { thread } = await res.json();
  assert.equal(thread.id, root);
  assert.equal(thread.replies.length, 2);
  const first = thread.replies.find(r => r.id === reply1);
  assert.equal(first.replies.length, 1);
  assert.equal(first.replies[0].id, nested);
  assert.ok(!JSON.stringify(thread).includes(unrelated));

  // Deleted messages stay in the tree as tombstones (exercised at store
  // level in tests/message-edit-delete.test.js).

  // Unknown message id 404s; non-members get 401.
  assert.equal((await fetch(`${origin}/api/rooms/commons/messages/${randomUUID()}/thread`,
    { headers: { Origin: origin, Authorization: `Bearer ${ownerKey}` } })).status, 404);
  assert.equal((await fetch(`${origin}/api/rooms/commons/messages/${root}/thread`,
    { headers: { Origin: origin } })).status, 401);
});

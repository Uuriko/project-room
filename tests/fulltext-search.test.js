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
  const directory = mkdtempSync(join(tmpdir(), "project-room-search-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); rmSync(directory, { recursive: true, force: true }); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const get = (path, token) => fetch(origin + path, { headers: { Origin: origin, ...(token ? { Authorization: `Bearer ${token}` } : {}) } });
  const post = (body, extra = {}) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: randomUUID(), body, ...extra } }).event.data.messageId;
  const propose = (title) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.WORK_PROPOSED, data: { workItemId: randomUUID(), title, definitionOfDone: "done when done", accountableMemberId: "owner", verifierMemberId: "owner", mode: "write" } });
  const remove = (messageId) => store.command(ownerKey, "commons",
    { id: randomUUID(), type: T.MESSAGE_DELETED, data: { messageId, expectedMessageRevision: 0, reason: "test" } });
  return { origin, ownerKey, get, post, propose, remove };
}

test("full-text search over messages and work (round-2 #113)", async t => {
  const { origin, ownerKey, get, post, propose, remove } = await serve(t);
  const keepId = post("The quick brown fox jumps");
  post("something unrelated here");
  const doomed = post("fox in the henhouse");
  propose("Fix the fox widget");

  // Deleted messages are tombstones and must not match.
  remove(doomed);

  const search = async (q, kind) => {
    const res = await get(`/api/rooms/commons/search?q=${encodeURIComponent(q)}${kind ? `&kind=${kind}` : ""}`, ownerKey);
    assert.equal(res.status, 200);
    return res.json();
  };

  let r = await search("fox");
  assert.equal(r.messages.length, 1);
  assert.equal(r.messages[0].id, keepId);
  assert.equal(r.workItems.length, 1);
  assert.equal(r.workItems[0].title, "Fix the fox widget");

  r = await search("fox", "messages");
  assert.equal(r.messages.length, 1);
  assert.equal(r.workItems.length, 0);

  r = await search("fox", "work");
  assert.equal(r.messages.length, 0);
  assert.equal(r.workItems.length, 1);

  // Case-insensitive.
  r = await search("FOX", "messages");
  assert.equal(r.messages.length, 1);

  // Bad input rejected.
  assert.equal((await get("/api/rooms/commons/search", ownerKey)).status, 422);
  assert.equal((await get("/api/rooms/commons/search?q=x&kind=bogus", ownerKey)).status, 422);
  // Non-members get 401.
  assert.equal((await get("/api/rooms/commons/search?q=fox")).status, 401);
});

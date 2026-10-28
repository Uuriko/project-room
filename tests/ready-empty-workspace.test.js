import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

// #3273: /api/ready must implement the documented semantics on BOTH runtimes —
// ready when the store answers, unavailable when storage is down. The Node
// handler used to add an undocumented rooms-existence condition, so a fresh,
// healthy, empty workspace answered 503 until someone created a room, while
// the Worker (storage probe only) answered ready for the same state.
async function bootEmptyStore(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-ready-empty-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  // Deliberately NO store.initialize(initialRoom()): zero rooms exist.
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM rooms").get().n, 0);
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  return { store, origin };
}

test("GET /api/ready is 200 {status:ready} on an empty workspace whose store answers", async t => {
  const { origin } = await bootEmptyStore(t);
  const response = await fetch(`${origin}/api/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
});

test("HEAD /api/ready agrees on an empty workspace", async t => {
  const { origin } = await bootEmptyStore(t);
  const response = await fetch(`${origin}/api/ready`, { method: "HEAD" });
  assert.equal(response.status, 200);
});

test("GET /api/ready stays 200 once a room exists (no behavior change for provisioned workspaces)", async t => {
  const { store, origin } = await bootEmptyStore(t);
  store.initialize(initialRoom());
  const response = await fetch(`${origin}/api/ready`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ready" });
});

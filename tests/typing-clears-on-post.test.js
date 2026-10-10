// rb-stale-typing (human-first runbook, Oct 9): after Ana's message posted,
// Ben still saw "Ana RB is typing…" until her last beat expired. Posting a
// message now clears the poster's beat, and only theirs.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { PERMISSIONS } from "../src/events.js";
import { clearBeat, currentTypists, recordBeat, typingBeats } from "../server/typing.mjs";

test("clearBeat drops one member's beat and the empty room", () => {
  const state = new Map();
  recordBeat(state, "r", { id: "a", displayName: "A" }); recordBeat(state, "r", { id: "b", displayName: "B" });
  assert.equal(clearBeat(state, "r", "a"), true);
  assert.deepEqual(currentTypists(state, "r", null).map(t => t.memberId), ["b"]);
  assert.equal(clearBeat(state, "r", "a"), false, "already gone");
  clearBeat(state, "r", "b");
  assert.equal(state.has("r"), false);
  assert.equal(clearBeat(state, "missing", "a"), false);
});

test("posting a message over HTTP clears the poster's typing beat, not anyone else's", async t => {
  const store = new RoomStore(":memory:");
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  for (const id of ["ana", "ben"]) store.command(owner, "commons", { id: `join-${id}`, type: "member.added", data: { memberId: id, displayName: id, kind: "agent", permissions: [...PERMISSIONS] } });
  const ana = store.issueAccessKey("commons", "ana");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { typingBeats.clear(); server.closeStreams(); server.closeAllConnections(); await new Promise(r => server.close(r)); store.close(); });
  recordBeat(typingBeats, "commons", { id: "ana", displayName: "ana" });
  recordBeat(typingBeats, "commons", { id: "ben", displayName: "ben" });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = id => fetch(`${origin}/api/rooms/commons/commands`, { method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ana}`, origin },
    body: JSON.stringify({ id: `cmd-${id}`, type: "message.posted", data: { messageId: id, body: "hello" } }) });
  const first = await post("m1");
  assert.equal(first.status, 201, await first.text());
  assert.deepEqual(currentTypists(typingBeats, "commons", null).map(t => t.memberId), ["ben"], "ana stopped typing, ben still is");
  recordBeat(typingBeats, "commons", { id: "ana", displayName: "ana" });
  assert.equal((await post("m1")).status, 200, "a duplicate retry");
  assert.deepEqual(currentTypists(typingBeats, "commons", null).map(t => t.memberId).sort(), ["ana", "ben"], "a duplicate retry is not a new post and leaves a fresh beat alone");
});

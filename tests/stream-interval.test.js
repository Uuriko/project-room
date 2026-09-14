import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// One open stream on a server with the given pump interval. `post` commits a
// message in-process; `next` resolves with the elapsed time when the stream
// parses the next room-event frame, or with null when `limitMs` passes first.
async function fixture(t, streamInterval) {
  const directory = mkdtempSync(join(tmpdir(), "room-stream-interval-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner"), sequence = store.room("commons").sequence;
  const server = createRoomServer({ store, streamInterval });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/stream?after=${sequence}`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(response.status, 200);
  const reader = response.body.getReader(), decoder = new TextDecoder();
  t.after(async () => {
    await reader.cancel().catch(() => {});
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  // The first pump runs synchronously at open and writes at least a heartbeat.
  let buffered = decoder.decode((await reader.read()).value);
  assert.ok(buffered.length > 0);
  const post = body => store.command(key, "commons", { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body } });
  const next = async limitMs => {
    const started = performance.now();
    while (!buffered.includes("event: room-event")) {
      const chunk = await Promise.race([reader.read(), sleep(limitMs).then(() => null)]);
      if (chunk === null || chunk.done) return null;
      buffered += decoder.decode(chunk.value, { stream: true });
    }
    return performance.now() - started;
  };
  return { post, next };
}

test("a shorter pump interval delivers a committed message sooner", async t => {
  const fast = await fixture(t, 20), slow = await fixture(t, 2000);
  slow.post("Waits for the next pump");
  fast.post("Arrives on the next pump");
  const fastElapsed = await fast.next(1500);
  assert.notEqual(fastElapsed, null, "20 ms pump delivered within 1.5 s");
  assert.ok(fastElapsed < 1000, `20 ms pump delivered in ${fastElapsed} ms`);
  // The 2000 ms pump has not ticked again yet, so nothing is on the wire.
  assert.equal(await slow.next(400), null, "2000 ms pump delivered nothing within 400 ms");
});

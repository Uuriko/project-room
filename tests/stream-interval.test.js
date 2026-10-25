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

// Delta sync: a committed event wakes its room's streams immediately — the
// pump interval no longer gates delivery. The interval now paces only the
// idle cadence (typing, keepalive, and the periodic authed re-check), so an
// idle stream must not re-read the store on every tick. `post` commits a
// message in-process; `next` resolves with the elapsed time when the stream
// parses the next room-event frame, or with null when `limitMs` passes first.
async function fixture(t, streamInterval) {
  const directory = mkdtempSync(join(tmpdir(), "room-stream-interval-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  const key = store.issueAccessKey("commons", "owner"), sequence = store.room("commons").sequence;
  let reads = 0;
  const eventsAfter = store.eventsAfter.bind(store);
  store.eventsAfter = (...args) => { reads++; return eventsAfter(...args); };
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
  return { post, next, reads: () => reads };
}

test("a committed message wakes the stream promptly, whatever the pump interval", async t => {
  const slow = await fixture(t, 2000);
  slow.post("Arrives on commit, not on the next pump");
  const elapsed = await slow.next(1500);
  assert.notEqual(elapsed, null, "2000 ms interval stream delivered within 1.5 s");
  assert.ok(elapsed < 1000, `commit-woken stream delivered in ${elapsed} ms`);
});

test("an idle stream does not re-read the store on every tick", async t => {
  const f = await fixture(t, 50);
  const opened = f.reads();
  assert.equal(opened, 2, "open validates once and pumps once");
  await sleep(1200);
  // The re-check cadence at a 50 ms interval is 250 ms, so ~5 light re-reads
  // in 1.2 s — against the legacy pump's ~24 full reads in the same window.
  const idleReads = f.reads() - opened;
  assert.ok(idleReads <= 7, `idle stream re-read the store ${idleReads} times in 1.2 s`);
  assert.equal(await f.next(300), null, "an idle stream receives no room events");
});

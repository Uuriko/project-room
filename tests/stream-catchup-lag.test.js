// R291-1: a fresh reader catching up on a backlog whose visible page exceeds
// the stream queue cap inside one tick must NOT be cut as lagging. The lag
// check used to run inside the write loop, so the current tick's own bytes
// tripped writableLength > cap and the server emitted stream_lagging, dropped
// the socket, and the client reconnected (and announced a false outage).
// Correct behavior: one connection carries the whole catch-up, zero
// stream_lagging frames, no gaps, no duplicates. The genuine-lag cut keeps
// its existing coverage in tests/stream-backpressure.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t, { streamQueueCap, streamInterval = 20 } = {}) {
  const f = createAcceptanceFixture();
  f.store.roomFlood = { consume() { return false; }, refund() {} }; // the test posts bursts; the flood guard is not under test
  const server = createRoomServer({ store: f.store, streamInterval, streamQueueCap });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = body => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { body } });
  const head = () => f.store.roomAuthority("commons").sequence;
  return { origin, post, keys: f.keys, head };
}

async function readFrames(res, onFrame, timeoutMs) {
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const chunk = await Promise.race([
        reader.read(),
        new Promise(resolve => setTimeout(() => resolve({ done: true, timeout: true }), timeoutMs))
      ]);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        onFrame(frame);
      }
    }
    await reader.cancel().catch(() => {}); // the stream stays open after the backlog is read; release it
  } catch { /* socket dropped by the server: the lag path */ }
}

const frameId = frame => { const m = /^id: (\d+)$/m.exec(frame); return m && /event: room-event/.test(frame) ? Number(m[1]) : null; };

test("fresh catch-up reader over a backlog larger than the queue cap is never cut as lagging", async t => {
  const { origin, post, keys, head } = await fixture(t, { streamQueueCap: 8192 });
  for (let i = 0; i < 25; i++) await post(`BIG ${i} ${"y".repeat(1200)}`);
  const total = head(); // the sequence after the posts includes the fixture's seed events
  let connects = 0, lags = 0, dup = 0, last = 0; const seen = new Set();
  while (last < total && connects < 50) {
    connects++;
    const res = await fetch(`${origin}/api/rooms/commons/stream`, {
      headers: { Authorization: `Bearer ${keys.producer}`, Origin: origin, "last-event-id": String(last) },
      signal: AbortSignal.timeout(8000)
    });
    const seenNow = { stop: false };
    await readFrames(res, frame => {
      if (/stream_lagging/.test(frame)) { lags++; seenNow.stop = true; }
      const id = frameId(frame);
      if (id !== null) { if (seen.has(id)) dup++; seen.add(id); last = id; }
      if (last >= total) seenNow.stop = true;
    }, 4000);
    if (lags > 0) break; // the regression under test
  }
  assert.equal(connects, 1, `expected one connect, got ${connects}`);
  assert.equal(lags, 0, `expected zero stream_lagging frames, got ${lags}`);
  assert.equal(dup, 0, `expected no duplicates, got ${dup}`);
  assert.equal(seen.size, total, `expected the full backlog, got ${seen.size}`);
});

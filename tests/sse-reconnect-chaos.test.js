// REL-19: local version of the #1446 SSE chaos probes (chaos/sse-chaos.mjs
// targets staging). A client that drops its stream and reconnects with
// Last-Event-ID must get every event after the last id it processed, with
// no gap and no duplicate. Bad resume cursors must be a 4xx, never a 500.
// Write counts stay under the room flood guard (30-post burst per member).
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval: 20 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const open = (headers = {}, query = "") => fetch(`${origin}/api/rooms/commons/stream${query}`, {
    headers: { Authorization: `Bearer ${f.keys.owner}`, ...headers }, signal: AbortSignal.timeout(5000)
  });
  const post = body => f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "message.posted", data: { body } });
  return { ...f, open, post };
}

// Read frames until `stop(ids)` is true, then cancel the reader (a hard drop).
async function readIds(response, stop) {
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let buffer = ""; const ids = [];
  try {
    while (!stop(ids)) {
      const chunk = await reader.read(); if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let cut;
      while ((cut = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, cut); buffer = buffer.slice(cut + 2);
        const id = /^id: (\d+)$/m.exec(frame);
        if (id && /^event: room-event$/m.test(frame)) ids.push(Number(id[1]));
      }
    }
  } finally { await reader.cancel().catch(() => {}); }
  return ids;
}

test("a stream dropped mid-burst resumes from Last-Event-ID with no gap and no duplicate", async t => {
  const f = await fixture(t);
  const start = f.store.room("commons").sequence;
  const sequences = [];
  for (let i = 0; i < 20; i++) sequences.push(f.post(`burst ${i}`).sequence);
  const first = await f.open({}, `?after=${start}`); assert.equal(first.status, 200);
  // The client processes 8 frames, then crashes. Frames that arrived in the
  // same chunk but were never processed must come again after the reconnect.
  const seen1 = (await readIds(first, ids => ids.length >= 8)).slice(0, 8);
  const last = seen1.at(-1);
  for (let i = 20; i < 26; i++) sequences.push(f.post(`burst ${i}`).sequence); // writes while offline
  const second = await f.open({ "Last-Event-ID": String(last) }); assert.equal(second.status, 200);
  const seen2 = await readIds(second, ids => ids.at(-1) >= sequences.at(-1));
  const delivered = [...seen1, ...seen2];
  assert.equal(seen2[0], last + 1, "resume starts right after the last processed id");
  assert.equal(new Set(delivered).size, delivered.length, "no duplicate ids across the reconnect");
  for (const seq of sequences) assert.ok(delivered.includes(seq), `sequence ${seq} delivered`);
  for (let i = 1; i < delivered.length; i++) assert.ok(delivered[i] > delivered[i - 1], "ids strictly increase");
});

test("Last-Event-ID wins over ?after, as the browser EventSource sends it on reconnect", async t => {
  const f = await fixture(t);
  const a = f.post("a").sequence, b = f.post("b").sequence, c = f.post("c").sequence;
  const response = await f.open({ "Last-Event-ID": String(b) }, `?after=${a - 1}`);
  assert.equal(response.status, 200);
  const ids = await readIds(response, ids => ids.includes(c));
  assert.deepEqual(ids.filter(id => id >= a), [c]);
});

test("ten drop/reconnect cycles during live writes lose nothing", async t => {
  const f = await fixture(t);
  let last = f.store.room("commons").sequence; const written = []; const delivered = [];
  for (let cycle = 0; cycle < 10; cycle++) {
    for (let i = 0; i < 2; i++) written.push(f.post(`cycle ${cycle}.${i}`).sequence);
    const response = await f.open({ "Last-Event-ID": String(last) }); assert.equal(response.status, 200);
    // Process one frame, then drop; anything else in that chunk is unprocessed.
    const ids = (await readIds(response, ids => ids.length >= 1)).slice(0, 1);
    delivered.push(...ids); last = ids.at(-1);
  }
  const response = await f.open({ "Last-Event-ID": String(last) });
  delivered.push(...await readIds(response, ids => ids.at(-1) >= written.at(-1)));
  assert.equal(new Set(delivered).size, delivered.length);
  for (const seq of written) assert.ok(delivered.includes(seq), `sequence ${seq} delivered`);
});

for (const [label, value, status, code] of [
  ["non-numeric", "abc", 422, "invalid_cursor"], ["negative", "-1", 422, "invalid_cursor"],
  ["fractional", "1.5", 422, "invalid_cursor"], ["ahead of history", "999999999", 409, "cursor_ahead"],
]) {
  test(`a ${label} Last-Event-ID is a ${status} ${code}, never a 500 or an empty 200`, async t => {
    const f = await fixture(t);
    const response = await f.open({ "Last-Event-ID": value });
    assert.equal(response.status, status);
    const body = await response.json();
    assert.equal(body.error?.code ?? body.code, code);
  });
}

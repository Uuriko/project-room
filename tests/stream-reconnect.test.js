import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function fixture(t, { streamInterval = 40 } = {}) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store, streamInterval });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true });
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { ...f, origin };
}

function posters(f, count) {
  // The flood guard budgets 30 burst posts per (room, member); rotate across
  // members so bulk probes never 429.
  const keys = [];
  for (let i = 0; i < count; i++) {
    const memberId = `probe-poster-${i}`;
    f.store.command(f.keys.owner, "commons", { id: randomUUID(), type: "member.added",
      data: { memberId, displayName: memberId, kind: "human", permissions: [] } });
    keys.push(f.store.issueAccessKey("commons", memberId));
  }
  return keys;
}

let postRotation = 0;
function post(f, keys, n, bodyPrefix = "probe") {
  const receipts = [];
  for (let i = 0; i < n; i++) {
    receipts.push(f.store.command(keys[(postRotation++) % keys.length], "commons", {
      id: randomUUID(), type: "message.posted", data: { body: `${bodyPrefix}-${i}` },
    }));
  }
  return receipts;
}

// Read SSE wire until `want` room-event ids are collected or the stream ends.
// Returns { ids, lastId, done } where done means the reader saw stream end.
async function collectIds(response, { want = Infinity, stopAfter = null, signal } = {}) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buf = "", lastId = null;
  const ids = [];
  let done = false;
  try {
    for (;;) {
      if (ids.length >= want) break;
      const chunk = await reader.read();
      if (chunk.done) { done = true; break; }
      buf += decoder.decode(chunk.value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, idx); buf = buf.slice(idx + 2);
        let id = null, ev = null;
        for (const line of frame.split("\n")) {
          if (line.startsWith("id: ")) id = line.slice(4).trim();
          else if (line.startsWith("event: ")) ev = line.slice(7).trim();
        }
        if (ev === "room-event" && id !== null) {
          lastId = id; ids.push(Number(id));
          if (stopAfter !== null && ids.length >= stopAfter) break;
        }
      }
      if (stopAfter !== null && ids.length >= stopAfter) break;
      if (signal?.aborted) break;
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  return { ids, lastId, done };
}

const auth = key => ({ Authorization: `Bearer ${key}` });

test("mid-batch disconnect resumes with Last-Event-ID: no gaps, no dupes, in order", async t => {
  const f = await fixture(t);
  const keys = posters(f, 6);
  const base = f.store.room("commons").sequence;
  const receipts = post(f, keys, 150);
  const finalSeq = receipts.at(-1).sequence;

  // Phase 1: open at base, read 60 events, then kill the connection.
  const first = await fetch(`${f.origin}/api/rooms/commons/stream?after=${base}`, { headers: auth(f.keys.owner) });
  assert.equal(first.status, 200);
  const part1 = await collectIds(first, { stopAfter: 60 });
  assert.equal(part1.ids.length, 60);
  assert.deepEqual(part1.ids, Array.from({ length: 60 }, (_, i) => base + 1 + i));

  // Phase 2: reconnect with Last-Event-ID, drain to the end.
  const second = await fetch(`${f.origin}/api/rooms/commons/stream?after=${base}`, {
    headers: { ...auth(f.keys.owner), "Last-Event-ID": String(part1.lastId) },
  });
  assert.equal(second.status, 200);
  const part2 = await collectIds(second, { want: 90 });
  const all = [...part1.ids, ...part2.ids];
  assert.equal(all.length, 150);
  assert.deepEqual(all, Array.from({ length: 150 }, (_, i) => base + 1 + i));
  assert.equal(part2.ids[0], Number(part1.lastId) + 1, "resume starts immediately after the last delivered id");
  assert.equal(all.at(-1), finalSeq);
});

test("burst larger than the 100-event page stays ordered and complete", async t => {
  const f = await fixture(t);
  const keys = posters(f, 10);
  const base = f.store.room("commons").sequence;
  const receipts = post(f, keys, 250);
  const finalSeq = receipts.at(-1).sequence;
  const res = await fetch(`${f.origin}/api/rooms/commons/stream?after=${base}`, { headers: auth(f.keys.owner) });
  assert.equal(res.status, 200);
  const { ids } = await collectIds(res, { want: 250 });
  assert.equal(ids.length, 250);
  assert.equal(ids.at(-1), finalSeq);
  assert.deepEqual(ids, Array.from({ length: 250 }, (_, i) => base + 1 + i));
});

test("two concurrent subscribers each receive every event", async t => {
  const f = await fixture(t);
  const keys = posters(f, 2);
  const base = f.store.room("commons").sequence;
  const receipts = post(f, keys, 40);
  const finalSeq = receipts.at(-1).sequence;
  const expected = Array.from({ length: 40 }, (_, i) => base + 1 + i);
  const open = () => fetch(`${f.origin}/api/rooms/commons/stream?after=${base}`, { headers: auth(f.keys.owner) });
  const [r1, r2] = await Promise.all([open(), open()]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  const [c1, c2] = await Promise.all([collectIds(r1, { want: 40 }), collectIds(r2, { want: 40 })]);
  assert.deepEqual(c1.ids, expected);
  assert.deepEqual(c2.ids, expected);
  assert.equal(c1.ids.at(-1), finalSeq);
});

test("connect with a cursor beyond the room sequence is refused, not an endless 200 loop", async t => {
  const f = await fixture(t);
  const seq = f.store.room("commons").sequence;
  const res = await fetch(`${f.origin}/api/rooms/commons/stream?after=${seq + 1000}`, { headers: auth(f.keys.owner) });
  // Characterization: the pre-check rejects cursor_ahead before the 200/SSE
  // headers are written, so EventSource sees a terminal HTTP error instead of
  // a 200 stream that can never deliver.
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error?.code, "cursor_ahead");
});

import { RoomClient } from "../src/client.js";

function clientFixture(t) {
  const streams = [], applied = [];
  let snapshotSequence = 0;
  const session = { roomId: "commons", member: { id: "human" }, account: { id: "account-human", authEpoch: 0 }, sessionBinding: "binding-one" };
  const snapshot = () => ({ sequence: snapshotSequence, roomId: "commons", viewerId: "human",
    viewerAccountId: session.account.id, viewerAuthEpoch: 0, viewerSessionBinding: session.sessionBinding });
  class Events extends EventTarget {
    constructor(url) { super(); this.url = url; this.readyState = 0; streams.push(this); }
    close() { this.readyState = 2; }
  }
  const client = new RoomClient({
    events: Events,
    fetcher: async () => ({ ok: true, json: async () => snapshot() }),
    onSnapshot: snap => applied.push(snap.sequence),
  });
  client.session = session;
  t.after(() => client.disconnect());
  return { client, streams, applied, setSequence: n => { snapshotSequence = n; } };
}

test("history replace regresses the sequence: refresh applies the new snapshot and the stream cursor resets", async t => {
  const { client, streams, applied, setSequence } = clientFixture(t);
  setSequence(500);
  await client.refresh();
  assert.equal(client.sequence, 500);
  assert.deepEqual(applied, [500]);

  // An operator replaces room history with a shorter log: the room sequence
  // regresses 500 -> 200. The next refresh must adopt the new history instead
  // of discarding it as stale, or the client's cursor stays ahead of the log
  // forever: every stream open fails 409 cursor_ahead and the UI never
  // recovers without a full reload.
  setSequence(200);
  await client.refresh();
  assert.equal(client.sequence, 200, "regressed snapshot must reset the cursor");
  assert.deepEqual(applied, [500, 200]);

  client.connect();
  assert.match(streams.at(-1).url, /after=200$/, "reconnect resumes from the replaced history head");
});

test("events posted while the stream is open arrive in order with no gaps", async t => {
  const f = await fixture(t);
  const keys = posters(f, 8);
  const base = f.store.room("commons").sequence;
  const res = await fetch(`${f.origin}/api/rooms/commons/stream?after=${base}`, { headers: auth(f.keys.owner) });
  assert.equal(res.status, 200);
  // Post 120 events from the test thread while the 40ms pump ticks: writes
  // interleave with pump reads across multiple pages.
  const posted = [];
  const posting = (async () => {
    for (let i = 0; i < 120; i++) {
      posted.push(post(f, keys, 1, `live-${i}`)[0].sequence);
      await new Promise(r => setTimeout(r, 5));
    }
  })();
  const { ids } = await collectIds(res, { want: 120 });
  await posting;
  assert.equal(ids.length, 120);
  assert.deepEqual(ids, posted, "wire order matches journal order under concurrent writes");
});

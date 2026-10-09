import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer, createStreamWriteQueue } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T } from "../src/events.js";


// The diagnostics route is owner-only through a signed-in account session.
async function ownerDiagnostics(store, origin) {
  const accountAccessKey = store.issueAccountAccessKey("account-owner");
  const bootstrapResponse = await fetch(`${origin}/api/account-session`);
  const cookie = bootstrapResponse.headers.get("set-cookie").split(";", 1)[0];
  const bootstrap = await bootstrapResponse.json();
  const login = await fetch(`${origin}/api/account-session`, { method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    body: JSON.stringify({ accountAccessKey, expectedSessionRevision: bootstrap.sessionRevision }) });
  assert.equal(login.status, 201);
  // QA-Auth 2026-09-19: the account-key login rotates the slot (QAS-702) —
  // the pre-login cookie is dead; the response cookie carries the session.
  const freshCookie = login.headers.get("set-cookie").split(";", 1)[0];
  // Connection: close — under a saturated event loop the server may idle out
  // a pooled keep-alive connection between polls; a fresh connection per
  // poll never reads as "other side closed".
  const headers = { Cookie: freshCookie, "X-Project-Room-Auth": "account", "X-Session-Binding": (await login.json()).sessionBinding, connection: "close" };
  return async () => {
    const response = await fetch(`${origin}/api/rooms/commons/diagnostics`, { headers });
    assert.equal(response.status, 200);
    return (await response.json()).diagnostics;
  };
}

// Loopback kernels absorb several megabytes before the server's own queue
// grows, so the producer commits batches until the stall is flagged.
const STREAM_INTERVAL = 15, QUEUE_CAP = 256 * 1024, BATCH = 40, MAX_BATCHES = 250;
// Capability lists replace the previous list, so the projection stays small
// while each event is ~2.5 KiB on the wire.
const post = () => ({ id: crypto.randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities: Array.from({ length: 30 }, (_, i) => `${i}-${"x".repeat(77)}`) } });

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-stream-backpressure-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  const owner = store.issueAccessKey("commons", "owner");
  const warnings = [];
  t.mock.method(console, "warn", line => warnings.push(String(line)));
  const server = createRoomServer({ store, streamInterval: STREAM_INTERVAL, streamQueueCap: QUEUE_CAP });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const sockets = [], readers = [], aborts = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    for (const controller of aborts) controller.abort();
    for (const reader of readers) await reader.cancel().catch(() => {});
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const headers = { Authorization: `Bearer ${owner}` };
  // A raw socket that stops reading after the response headers: the kernel
  // buffers fill, then the server's own send queue grows past the cap.
  async function openStalled(after) {
    const socket = connect(port, "127.0.0.1"); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(`GET /api/rooms/commons/stream?after=${after} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${owner}\r\nAccept: text/event-stream\r\n\r\n`);
    const head = await new Promise(resolve => socket.once("data", chunk => resolve(chunk.toString("utf8"))));
    assert.match(head, /^HTTP\/1\.1 200 /);
    socket.pause();
    return {
      // Resolves at the chunked terminator: the server ends the response but leaves the keep-alive socket to the client.
      drain: () => new Promise(resolve => {
        let raw = head;
        const finish = () => resolve(raw);
        socket.on("data", chunk => { raw += chunk.toString("utf8"); if (raw.endsWith("\r\n0\r\n\r\n")) finish(); });
        socket.once("end", finish); socket.once("close", finish);
        socket.resume();
      })
    };
  }
  async function openReading(after) {
    const controller = new AbortController(); aborts.push(controller);
    const response = await fetch(`${origin}/api/rooms/commons/stream?after=${after}`, { headers, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); readers.push(reader);
    const received = { text: "", done: false };
    (async () => {
      const decoder = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) { received.done = true; return; } received.text += decoder.decode(value, { stream: true }); }
    })().catch(() => { received.done = true; });
    return { response, received };
  }
  const diagnostics = await ownerDiagnostics(store, origin);
  return { store, owner, origin, headers, openStalled, openReading, diagnostics, warnings };
}

const eventIds = text => [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));

test("a client that never reads is closed with stream_lagging while a reading peer keeps receiving", async t => {
  const { store, owner, origin, headers, openStalled, openReading, diagnostics, warnings } = await fixture(t);
  const start = store.room("commons").sequence;
  const stalled = await openStalled(start);
  const reading = await openReading(start);
  let lagRecord = null, produced = 0;
  for (let batch = 0; batch < MAX_BATCHES && !lagRecord; batch++) {
    store.transaction(() => { for (let i = 0; i < BATCH; i++) { store.command(owner, "commons", post()); produced++; } });
    await sleep(STREAM_INTERVAL * 2);
    lagRecord = (await diagnostics()).find(entry => entry.code === "stream_lagging") ?? null;
  }
  assert.ok(lagRecord, `the stalled stream was never flagged after ${produced} events`);
  assert.deepEqual(Object.keys(lagRecord).sort(), ["at", "category", "code", "operationId", "route", "status"]);
  assert.equal(lagRecord.route, "/api/rooms/:roomId/stream"); assert.equal(lagRecord.category, "unavailable");
  assert.match(lagRecord.operationId, /^op_/);
  assert.ok(warnings.some(line => line === `room diagnostic ${lagRecord.operationId} 200 stream_lagging unavailable /api/rooms/:roomId/stream`));
  // The stalled client drains what the server queued: its last event is the lagging notice and nothing follows.
  const raw = await stalled.drain();
  const lagAt = raw.indexOf("event: stream_lagging");
  assert.ok(lagAt > 0, "the final event names the reason");
  assert.match(raw.slice(lagAt), /^event: stream_lagging\ndata: \{"message":"Client fell behind; reconnect with Last-Event-ID to resume"\}\n\n/);
  assert.doesNotMatch(raw.slice(lagAt), /event: room-event/);
  assert.match(raw, /\r\n0\r\n\r\n$/, "the response ends cleanly rather than being torn down");
  const stalledIds = eventIds(raw);
  assert.ok(stalledIds.length > 0 && stalledIds.at(-1) < start + produced, "the stalled client did not get everything");
  // The reading peer never lagged and keeps receiving new events after the stalled peer was closed.
  const last = store.command(owner, "commons", post()).sequence;
  for (let waited = 0; waited < 200 && !eventIds(reading.received.text).includes(last); waited++) await sleep(STREAM_INTERVAL);
  assert.ok(eventIds(reading.received.text).includes(last), `the healthy peer receives the event posted after the slow peer closed (done=${reading.received.done} ids=${eventIds(reading.received.text).length} last=${eventIds(reading.received.text).at(-1)} expected=${last} produced=${produced} lagRecords=${(await diagnostics()).filter(entry => entry.code === "stream_lagging").length} tail=${JSON.stringify(reading.received.text.slice(-200))})`);
  assert.equal(reading.received.done, false);
  assert.doesNotMatch(reading.received.text, /stream_lagging/);
  assert.equal((await diagnostics()).filter(entry => entry.code === "stream_lagging").length, 1, "one record per lagging stream");
  // A client reconnecting from its last id resumes the events it missed, and the
  // lagging stream released its slot: the same credential is back to three streams.
  const resumed = await fetch(`${origin}/api/rooms/commons/stream`, { headers: { ...headers, "Last-Event-ID": String(stalledIds.at(-1)) }, signal: AbortSignal.timeout(5000) });
  assert.equal(resumed.status, 200);
  const chunk = new TextDecoder().decode((await resumed.body.getReader().read()).value);
  assert.equal(eventIds(chunk)[0], stalledIds.at(-1) + 1);
  const third = await fetch(`${origin}/api/rooms/commons/stream?after=${last}`, { headers, signal: AbortSignal.timeout(5000) });
  assert.equal(third.status, 200, "the closed stream no longer occupies a slot");
  for (const response of [resumed, third]) await response.body.cancel().catch(() => {});
});

test("the stream queue cap is validated", () => {
  for (const streamQueueCap of [0, -1, 1.5, "64k"]) assert.throws(() => createRoomServer({ store: {}, streamQueueCap }), /Stream queue cap/);
});

test("createStreamWriteQueue bounds a stream's pending bytes and never writes after destroy", () => {
  const written = [];
  const target = {
    writableLength: 0, destroyed: false, writableEnded: false,
    write(chunk) { written.push(chunk); this.writableLength += Buffer.byteLength(chunk); },
  };
  const queue = createStreamWriteQueue(target, 10);
  assert.equal(queue.capBytes, 10);
  assert.equal(queue.write("12345"), true, "5 bytes under the cap keeps flowing");
  assert.equal(queue.write("12345"), true, "exactly at the cap still flows (trip is strictly greater)");
  assert.equal(queue.lagging(), false);
  assert.equal(queue.write("1"), false, "the write that pushes over the cap reports not-flowing");
  assert.equal(queue.lagging(), true);
  assert.equal(queue.pendingBytes(), 11);
  assert.deepEqual(written, ["12345", "12345", "1"], "the tripping write still lands; the caller stops after");
  target.destroyed = true;
  assert.equal(queue.write("x"), false, "no write after destroy");
  assert.equal(written.length, 3);
  target.destroyed = false; target.writableEnded = true;
  assert.equal(queue.write("y"), false, "no write after end");
  assert.equal(written.length, 3);
});

// ---- slow-consumer swarm: 1 slow + 99 normal --------------------------------
// The queue cap (256 KiB) sits above the healthy per-tick burst (at most ~2
// production batches = ~100 KiB land in one tick) so eager peers never trip
// it, while the slow consumer's queue grows every tick until the cap.
// The pump interval is 2000 ms: a per-stream pump tick costs ~10 ms of
// event-loop (measured: eventsAfter at head), so 100 streams at the 250 ms
// default would 4x-oversubscribe the loop even with no slow consumer —
// that aggregate cost is the F1 shared pump's problem (wave300-fanout-perf),
// not this guard's. At 2000 ms the loop stays ~50% busy and the test is
// fast and reliable.
const SWARM_INTERVAL = 2000, SWARM_CAP = 256 * 1024, SWARM_BATCH = 20, SWARM_MAX_BATCHES = 120;

async function swarmFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-stream-swarm-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.bindHumanAccount("commons", "owner", "account-owner");
  const ownerKey = store.issueAccessKey("commons", "owner");
  // One active key per member: 34 members hold the 100-stream pool
  // (33 x 3 peers + 1 slow consumer).
  const keys = [];
  for (let i = 0; i < 34; i++) {
    const memberId = `swarm-${i}`;
    store.command(ownerKey, "commons", { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work", "complete_work"] } });
    keys.push(store.issueAccessKey("commons", memberId));
  }
  const server = createRoomServer({ store, streamInterval: SWARM_INTERVAL, streamQueueCap: SWARM_CAP });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port, origin = `http://127.0.0.1:${port}`;
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  // Raw sockets: undici's per-origin connection cap would queue the 99
  // fetch-based peers, so every stream here is a real TCP connection.
  async function probeOpen(key, after) {
    const socket = connect(port, "127.0.0.1"); sockets.push(socket);
    await new Promise((resolve, reject) => { socket.once("connect", resolve); socket.once("error", reject); });
    socket.write(`GET /api/rooms/commons/stream?after=${after} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${key}\r\nAccept: text/event-stream\r\n\r\n`);
    const head = await new Promise(resolve => socket.once("data", chunk => { socket.pause(); resolve(chunk.toString("utf8")); }));
    return { socket, status: Number(head.slice(9, 12)) };
  }
  async function openSocket(key, after) {
    const { socket, status } = await probeOpen(key, after);
    assert.equal(status, 200);
    return socket;
  }
  // Normal peer: reads eagerly; records marker arrival times per chunk with
  // a small overlap so a marker split across chunks is still caught. Event
  // bodies are not accumulated (99 peers x a multi-MB flood would blow up
  // the test process).
  function openPeer(key, after, pendingMarkers) {
    return openSocket(key, after).then(socket => {
      const arrivals = new Map();
      let tail = "";
      socket.on("data", chunk => {
        const text = tail + chunk.toString("utf8");
        tail = text.slice(-64);
        for (const [seq, t0] of pendingMarkers) {
          if (!arrivals.has(seq) && text.includes(`id: ${seq}\n`)) arrivals.set(seq, performance.now() - t0);
        }
        if (text.includes("event: stream_lagging")) arrivals.set("LAGGING", -1);
      });
      socket.resume();
      return arrivals;
    });
  }
  // Slow consumer: the socket stays paused; the client takes ~1 message
  // worth of bytes per second via synchronous read(). The kernel buffer
  // fills between reads, so the server's per-stream queue grows — the
  // slow-consumer pathology.
  function openSlow(key, after) {
    return openSocket(key, after).then(socket => {
      const state = { raw: "", reads: 0, lagging: false, ended: false };
      socket.on("end", () => { state.ended = true; });
      socket.on("close", () => { state.ended = true; });
      (async () => {
        for (;;) {
          if (state.ended) break;
          const chunk = socket.read(2048); // ~1 message per wake: true 1 msg/sec drain
          if (chunk) { state.reads++; state.raw += chunk.toString("utf8"); }
          if (state.raw.includes("event: stream_lagging")) state.lagging = true;
          await sleep(1000);
        }
      })().catch(() => {});
      return state;
    });
  }
  const diagnostics = await ownerDiagnostics(store, origin);
  return { store, ownerKey, origin, keys, probeOpen, openPeer, openSlow, diagnostics };
}

test("one slow consumer among 99 peers: the slow one gets stream_lagging, peers keep up", async t => {
  const { store, ownerKey, keys, probeOpen, openPeer, openSlow, diagnostics } = await swarmFixture(t);
  const start = store.room("commons").sequence;
  const pendingMarkers = new Map();
  await openSlow(keys[33], start);
  // Open the 99 peers in parallel: sequential opens cost ~400 ms each
  // (mostly server-side stream setup), which would dominate the test.
  // The admission checks run synchronously per request, so parallel opens
  // of the same credential still respect the 3-stream cap.
  const peerArrivals = (await Promise.all(
    Array.from({ length: 33 }, (_, m) =>
      Promise.all([0, 1, 2].map(() => openPeer(keys[m], start, pendingMarkers)))),
  )).flat();
  assert.equal(peerArrivals.length, 99, "99 normal peers are open alongside the slow consumer");
  await sleep(SWARM_INTERVAL * 2);
  // Flood until the slow consumer's queue trips the cap.
  let lagRecord = null;
  for (let batch = 0; batch < SWARM_MAX_BATCHES && !lagRecord; batch++) {
    store.transaction(() => { for (let i = 0; i < SWARM_BATCH; i++) store.command(ownerKey, "commons", post()); });
    await sleep(SWARM_INTERVAL + 50);
    lagRecord = (await diagnostics()).find(entry => entry.code === "stream_lagging") ?? null;
  }
  assert.ok(lagRecord, "the slow consumer was flagged stream_lagging");
  assert.equal(lagRecord.route, "/api/rooms/:roomId/stream");
  // The lagging notice is queued behind the slow consumer's backlog, which
  // it drains at 1 msg/sec — the exact final bytes are proven by the
  // single-stream test above ("the final event names the reason"); here
  // the diagnostic record plus the freed slot prove the drop happened.
  assert.equal((await diagnostics()).filter(entry => entry.code === "stream_lagging").length, 1,
    "exactly one lagging record: no eager peer tripped the cap");
  assert.ok(!peerArrivals.some(arrivals => arrivals.has("LAGGING")), "no peer saw stream_lagging");
  // The dropped stream released its slot: the same credential reopens.
  const replacement = await probeOpen(keys[33], start);
  assert.equal(replacement.status, 200, "the closed stream no longer occupies a slot");
  replacement.socket.destroy();
  // Peers keep receiving after the slow consumer was dropped: every peer
  // must see every marker, with bounded added latency.
  const markerSeqs = [];
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const seq = store.command(ownerKey, "commons", post()).sequence;
    pendingMarkers.set(seq, t0);
    markerSeqs.push(seq);
    await sleep(500);
  }
  for (let waited = 0; waited < 600; waited++) {
    await sleep(100);
    if (peerArrivals.every(arrivals => arrivals.size >= markerSeqs.length)) break;
  }
  for (const arrivals of peerArrivals) {
    assert.equal(arrivals.size, markerSeqs.length, "every peer received every marker posted after the slow consumer was dropped");
  }
  const latencies = [];
  for (const arrivals of peerArrivals) for (const seq of markerSeqs) latencies.push(arrivals.get(seq));
  latencies.sort((a, b) => a - b);
  const p99 = latencies[Math.floor(latencies.length * 0.99)];
  assert.ok(latencies.at(-1) < 30000,
    `peer marker latency stays bounded while a slow consumer is dropped (max=${latencies.at(-1).toFixed(0)}ms p99=${p99.toFixed(0)}ms over ${latencies.length} deliveries)`);
});

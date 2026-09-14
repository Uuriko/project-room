import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
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
  const headers = { Cookie: cookie, "X-Project-Room-Auth": "account", "X-Session-Binding": (await login.json()).sessionBinding };
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

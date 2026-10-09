// WAVE-500 W3: shared SSE pump correctness + cursor edge cases.
//
// The F1 shared pump (one interval per room, single eventsAfter fetch per
// tick fanned out per stream) is NOT in this base yet — each stream still
// owns its own setInterval(pump). This file therefore has two sections:
//
//   PART A — pump correctness contracts. These hold on ANY correct pump
//   implementation (per-stream today, shared after W2) and are green now.
//   Each pins behavior the F1 design explicitly requires preserved:
//   per-stream cursors + Last-Event-ID resume, stream_lagging drops,
//   access-ended on 401/403, the 3-stream / 100-stream caps, the far-behind
//   catch-up bound, and dead-socket pruning.
//
//   PART B — fail-first shared-pump architecture pins. These assert the F1
//   design contract itself (single shared fetch per room per tick, riding
//   the minimum cursor, with { includeInvisible: true }). They FAIL on the
//   per-stream architecture and must go green when W2's pump lands.
//
// Authoring-gate notes (repo test-audit skill): every test names the
// observable contract and the credible regression; stream_limit caps at the
// 100-stream level are owned by tests/load-test-10x.test.js and are not
// re-asserted here — Part A covers only the teardown paths that test does
// not (access-ended slot release, cross-room lag isolation).
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

const eventIds = text => [...text.matchAll(/^id: (\d+)$/gm)].map(match => Number(match[1]));
const range = (from, to) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

// Fresh store + server. `rooms` lists the room ids to initialize (each gets
// an owner access key in `keys`). `mockWarn` captures console.warn lines for
// the stream_lagging diagnostic the pump emits.
async function fixture(t, { streamInterval = 25, streamQueueCap = 65536, rooms = ["commons"], mockWarn = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "room-shared-pump-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  for (const roomId of rooms) store.initialize(initialRoom(roomId));
  const keys = {};
  for (const roomId of rooms) keys[roomId] = store.issueAccessKey(roomId, "owner");
  const warnings = [];
  if (mockWarn) t.mock.method(console, "warn", line => warnings.push(String(line)));
  const server = createRoomServer({ store, streamInterval, streamQueueCap });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const controllers = [], readers = [], sockets = [];
  t.after(async () => {
    for (const controller of controllers) controller.abort();
    for (const reader of readers) await reader.cancel().catch(() => {});
    for (const socket of sockets) socket.destroy();
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  const post = (roomId, body, key) => store.command(key ?? keys[roomId], roomId,
    { id: crypto.randomUUID(), type: T.MESSAGE_POSTED, data: { body } });
  // Bulk sequenced events that do NOT spend room-flood tokens (only
  // message.posted/dm.posted consume the per-member burst budget), following
  // the convention in tests/stream-backpressure.test.js. Visible on streams.
  const bulkPost = (roomId, label, key) => store.command(key ?? keys[roomId], roomId,
    { id: crypto.randomUUID(), type: T.CAPABILITIES_ADVERTISED, data: { capabilities: [label] } });
  // NOTE: issueAccessKey revokes the member's other credentials in the room
  // (single-active-key rotation semantics), so each simultaneously-valid
  // credential needs its own member.
  let agentSeq = 0;
  const addAgent = (roomId = "commons") => {
    const memberId = `pump-agent-${agentSeq++}`;
    store.command(keys[roomId], roomId, { id: crypto.randomUUID(), type: T.MEMBER_ADDED,
      data: { memberId, displayName: memberId, kind: "agent", permissions: ["accept_work"] } });
    return { memberId, key: store.issueAccessKey(roomId, memberId) };
  };
  // Fetch-based SSE stream with a background accumulator, following the
  // convention in tests/stream-backpressure.test.js.
  async function openReading(roomId, key, after, extraHeaders = {}) {
    const controller = new AbortController(); controllers.push(controller);
    const response = await fetch(`${origin}/api/rooms/${roomId}/stream?after=${after}`,
      { headers: { Authorization: `Bearer ${key}`, ...extraHeaders }, signal: controller.signal });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); readers.push(reader);
    const received = { text: "", done: false };
    (async () => {
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) { received.done = true; return; }
        received.text += decoder.decode(value, { stream: true });
      }
    })().catch(() => { received.done = true; });
    return { response, received, ids: () => eventIds(received.text), close: () => controller.abort() };
  }
  const waitFor = async (condition, timeoutMs, what) => {
    const started = Date.now();
    while (!condition()) {
      if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for: ${what}`);
      await sleep(25);
    }
  };
  return { store, server, origin, keys, post, bulkPost, addAgent, openReading, waitFor, warnings, sockets };
}

// Raw-socket stream open: no undici per-origin connection cap, so the
// 100-stream pool tests and the never-reading stalled streams are reachable.
function openRaw(origin, roomId, key, after, sockets) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const socket = connect(Number(url.port), url.hostname);
    sockets.push(socket);
    socket.once("error", reject);
    socket.once("connect", () => socket.write(
      `GET /api/rooms/${roomId}/stream?after=${after} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${key}\r\n\r\n`));
    let head = "";
    const onHead = chunk => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n\r\n")) { socket.off("data", onHead); resolve({ socket, head, status: Number(head.slice(9, 12)) }); }
    };
    socket.on("data", onHead);
  });
}

// Raw-socket open that also reads a 429 JSON error body, mirroring the
// connection-pool test in tests/load-test-10x.test.js.
function openRawStatus(origin, roomId, key, after) {
  return new Promise((resolve, reject) => {
    const url = new URL(origin);
    const socket = connect(Number(url.port), url.hostname);
    socket.once("error", reject);
    let head = "";
    const onData = chunk => {
      head += chunk.toString("latin1");
      const end = head.indexOf("\r\n\r\n");
      if (end === -1) return;
      const status = Number(head.slice(9, 12));
      if (status === 200) { socket.off("data", onData); resolve({ socket, status, code: null }); return; }
      const length = Number(/content-length: (\d+)/i.exec(head)?.[1] ?? 0);
      const body = head.slice(end + 4);
      if (body.length < length) return;
      socket.off("data", onData);
      let code = null;
      try { code = JSON.parse(body).error?.code ?? null; } catch { /* non-JSON body */ }
      resolve({ socket, status, code });
    };
    socket.on("data", onData);
    socket.write(`GET /api/rooms/${roomId}/stream?after=${after} HTTP/1.1\r\nHost: ${url.host}\r\nAuthorization: Bearer ${key}\r\n\r\n`);
  });
}

// Drain a paused-then-resumed stalled socket: resolves with everything the
// server queued, ending at the chunked terminator or socket close.
function drainRaw(stalled) {
  return new Promise(resolve => {
    let raw = stalled.head;
    const finish = () => resolve(raw);
    stalled.socket.on("data", chunk => {
      raw += chunk.toString("latin1");
      if (raw.includes("\r\n0\r\n\r\n")) finish();
    });
    stalled.socket.once("end", finish);
    stalled.socket.once("close", finish);
    stalled.socket.resume();
  });
}

// ---------------------------------------------------------------------------
// PART A — pump correctness contracts (green on any correct implementation)
// ---------------------------------------------------------------------------

test("per-stream cursors stay independent: a far-behind and an at-head stream each get exactly their own window", async t => {
  // Contract: cursor state is per stream; the shared-window fan-out must
  // filter rows to `sequence > stream.cursor` per stream. Regression: a W2
  // bug that writes the union page to every stream, or drags an ahead
  // stream's cursor back to the shared window, replays backlog as "new".
  const f = await fixture(t, { streamInterval: 25 });
  const start = f.store.room("commons").sequence;
  for (let i = 0; i < 250; i++) f.bulkPost("commons", `backlog-${i}`);
  const head = f.store.room("commons").sequence;
  assert.equal(head, start + 250);
  const behind = await f.openReading("commons", f.keys.commons, start);
  const atHead = await f.openReading("commons", f.keys.commons, head);
  await f.waitFor(() => behind.ids().length >= 250, 10000, "far-behind stream to catch up");
  assert.deepEqual(atHead.ids(), [], "at-head stream receives none of the backlog rows");
  for (let i = 0; i < 3; i++) f.post("commons", `live-${i}`);
  await f.waitFor(() => atHead.ids().length >= 3, 10000, "at-head stream to receive live events");
  await f.waitFor(() => behind.ids().length >= 253, 10000, "far-behind stream to receive live events");
  await sleep(150); // let any stray duplicate land before asserting exactness
  assert.deepEqual(behind.ids(), range(start + 1, start + 253),
    "far-behind stream got exactly its window, in order, delivered once each");
  assert.deepEqual(atHead.ids(), [start + 251, start + 252, start + 253],
    "at-head stream got only the new events — no replay of rows ahead of its cursor");
});

test("Last-Event-ID resume after a dropped connection is exact: no gaps, no duplicates", async t => {
  // Contract: a stream that dies mid-batch keeps its last-SENT sequence, so
  // Last-Event-ID resume is exact (F1 design: "a lagging stream keeps its
  // last-sent sequence"). Regression: cursor advanced past unsent rows
  // (e.g. cursor = page.next before the batch is queued) silently skips
  // events on resume. Distinct from the lag-drop resume path covered in
  // tests/stream-backpressure.test.js — this is the clean-disconnect path.
  const f = await fixture(t, { streamInterval: 25 });
  const start = f.store.room("commons").sequence;
  for (let i = 0; i < 10; i++) f.post("commons", `msg-${i}`);
  const first = await f.openReading("commons", f.keys.commons, start);
  await f.waitFor(() => first.ids().length >= 10, 10000, "first stream to receive all 10");
  first.close();
  await f.waitFor(() => first.received.done, 10000, "first stream to end after the client drop");
  const resumeFrom = start + 5;
  const second = await f.openReading("commons", f.keys.commons, start, { "Last-Event-ID": String(resumeFrom) });
  await f.waitFor(() => second.ids().length >= 5, 10000, "resumed stream to receive the remainder");
  assert.equal(second.ids()[0], resumeFrom + 1, "resume starts exactly after the last processed id");
  assert.deepEqual(second.ids(), range(resumeFrom + 1, start + 10), "remainder arrives complete, in order, once each");
});

test("a lagging stream is dropped within ~5s while another room's streams keep flowing", async t => {
  // Contract: stream_lagging kills only the lagging stream; peers — and
  // other rooms' pumps — are unaffected. Regression: a shared per-room pump
  // whose lag-drop tears down the room interval (or a global registry keyed
  // wrong) stalls every room. tests/stream-backpressure.test.js covers the
  // single-room kill; this covers cross-room isolation, which only a
  // per-room pump can break.
  const f = await fixture(t, { streamInterval: 15, streamQueueCap: 256 * 1024, rooms: ["commons", "second"], mockWarn: true });
  const big = () => ({ id: crypto.randomUUID(), type: T.CAPABILITIES_ADVERTISED,
    data: { capabilities: Array.from({ length: 30 }, (_, i) => `${i}-${"x".repeat(77)}`) } });
  const stalled = await openRaw(f.origin, "commons", f.keys.commons, f.store.room("commons").sequence, f.sockets);
  assert.equal(stalled.status, 200);
  stalled.socket.pause(); // never reads: kernel buffers fill, then the server queue
  const peer = await f.openReading("second", f.keys.second, f.store.room("second").sequence);
  let flagged = false;
  for (let batch = 0; batch < 120 && !flagged; batch++) {
    f.store.transaction(() => { for (let i = 0; i < 40; i++) f.store.command(f.keys.commons, "commons", big()); });
    await sleep(30);
    flagged = f.warnings.some(line => line.includes("stream_lagging"));
  }
  assert.ok(flagged, "the stalled commons stream was flagged stream_lagging");
  assert.doesNotMatch(peer.received.text, /stream_lagging/, "the other room's stream is never flagged");
  const live1 = f.post("second", "peer-live-during-lag").sequence;
  await f.waitFor(() => peer.ids().includes(live1), 10000, "peer to receive an event while the other room lags");
  const raw = await drainRaw(stalled);
  const lagAt = raw.indexOf("event: stream_lagging");
  assert.ok(lagAt > 0, "stalled client got the lagging notice");
  assert.match(raw.slice(lagAt), /^event: stream_lagging\ndata: \{"message":"Client fell behind; reconnect with Last-Event-ID to resume"\}\n\n/);
  assert.doesNotMatch(raw.slice(lagAt), /event: room-event/, "nothing is sent after the lagging notice");
  await f.waitFor(() => stalled.socket.destroyed, 9000, "stalled socket to be dropped within the drain grace");
  const live2 = f.post("second", "peer-live-after-kill").sequence;
  await f.waitFor(() => peer.ids().includes(live2), 10000, "peer to receive an event after the lagging stream died");
  assert.equal(peer.received.done, false, "peer stream stays open throughout");
  assert.equal(f.warnings.filter(line => line.includes("stream_lagging")).length, 1, "exactly one lagging record");
});

test("revoking a credential ends only its streams with access-ended; peers keep streaming", async t => {
  // Contract: per-stream authenticate on every pump tick; a 401/403 ends
  // only that stream. Regression: a shared pump that authenticates once per
  // tick for the whole room (or that broadcasts access-ended) would kill
  // healthy peers when one credential is revoked.
  const f = await fixture(t, { streamInterval: 25 });
  const keyA = f.keys.commons, { key: keyB } = f.addAgent("commons");
  const head = f.store.room("commons").sequence;
  const a = await f.openReading("commons", keyA, head);
  const b = await f.openReading("commons", keyB, head);
  await sleep(100);
  f.store.revoke(keyA);
  await f.waitFor(() => a.received.done, 10000, "revoked stream to end");
  assert.match(a.received.text, /event: access-ended/, "revoked stream ends with access-ended");
  assert.doesNotMatch(a.received.text, /event: unavailable/, "revocation is conclusive, not a transport blip");
  const live = f.post("commons", "peer-still-here", keyB).sequence;
  await f.waitFor(() => b.ids().includes(live), 10000, "peer to receive post-revocation events");
  assert.equal(b.received.done, false, "peer stream stays open");
  assert.doesNotMatch(b.received.text, /access-ended/, "peer never sees access-ended");
});

test("rotating the identity secret ends only that session's stream with access-ended", async t => {
  // Contract: the RC-2026-09-23-106 identity-secret binding is enforced on
  // every pump tick, per stream. Regression: same shape as revocation — a
  // room-wide auth check on rotation would end every stream in the room.
  // Setup mirrors tests/join-session-1522.test.js.
  const f = await fixture(t, { streamInterval: 25 });
  const ownerKey = f.keys.commons;
  const identity = f.store.identities.create("pump agent");
  const { memberId } = f.store.identities.link(ownerKey, "commons", {
    identityId: identity.identityId, displayName: "Pump Agent", permissions: ["accept_work"] });
  const { token: sessionKey } = f.store.createJoinSession("commons", memberId);
  const head = f.store.room("commons").sequence;
  const sess = await f.openReading("commons", sessionKey, head);
  const peer = await f.openReading("commons", ownerKey, head);
  await sleep(100);
  f.store.identities.rotate(identity.identityId, identity.secret);
  await f.waitFor(() => sess.received.done, 10000, "rotated session stream to end");
  assert.match(sess.received.text, /event: access-ended/, "rotated session ends with access-ended");
  const live = f.post("commons", "peer-after-rotation", ownerKey).sequence;
  await f.waitFor(() => peer.ids().includes(live), 10000, "peer to receive post-rotation events");
  assert.equal(peer.received.done, false, "peer stream stays open");
  assert.doesNotMatch(peer.received.text, /access-ended/, "peer never sees access-ended");
});

test("streams ended by access-ended release their slots in the 100-stream pool", async t => {
  // Contract: the access-ended teardown removes the entry from the stream
  // set, freeing both the per-credential and the global pool slots.
  // Regression: a teardown path that ends the response without deleting the
  // entry leaks pool slots — a mass-revocation would wedge the 100-stream
  // pool. tests/load-test-10x.test.js covers pool exhaustion + manual
  // release; this covers the auth-driven teardown path it does not.
  const f = await fixture(t, { streamInterval: 250 });
  const head = f.store.room("commons").sequence;
  const agents = Array.from({ length: 34 }, () => f.addAgent("commons"));
  const held = [];
  for (let k = 0; k < 33; k++) for (let s = 0; s < 3; s++) held.push(await openRawStatus(f.origin, "commons", agents[k].key, head));
  held.push(await openRawStatus(f.origin, "commons", agents[33].key, head));
  assert.ok(held.every(h => h.status === 200), "pool holds exactly 100 streams");
  const over = await openRawStatus(f.origin, "commons", agents[33].key, head);
  assert.equal(over.status, 429);
  assert.equal(over.code, "stream_limit");
  over.socket.destroy();
  f.store.revoke(agents[0].key); // 3 streams die with access-ended on the next ticks
  await sleep(1000);
  for (const h of held) f.sockets.push(h.socket);
  for (let i = 0; i < 3; i++) { // pool is back to 97: three fresh opens succeed
    const r = await openRawStatus(f.origin, "commons", f.addAgent("commons").key, head);
    assert.equal(r.status, 200, `freed pool slot ${i + 1} is reusable after access-ended`);
    f.sockets.push(r.socket);
  }
  const capped = await openRawStatus(f.origin, "commons", f.addAgent("commons").key, head);
  assert.equal(capped.status, 429, "pool is full again at 100");
  assert.equal(capped.code, "stream_limit");
  capped.socket.destroy();
});

test("a far-behind stream stalls peers only within the 100-rows-per-tick catch-up bound", async t => {
  // Contract (accepted F1 tradeoff, quantified): under the shared pump a
  // stream ahead of the shared window waits while a far-behind stream
  // catches up at 100 rows/tick — the wait is BOUNDED by backlog/100 ticks
  // and converges, never an unbounded hang. Socket-lagged streams are
  // killed by stream_lagging (~5s), bounding the non-draining case.
  // Regression: a catch-up loop that never advances the laggard stalls the
  // room forever. Green on the per-stream pump (peers never wait); pins the
  // bound the shared pump must honor.
  const interval = 25;
  const f = await fixture(t, { streamInterval: interval });
  const start = f.store.room("commons").sequence;
  const BACKLOG = 400;
  for (let i = 0; i < BACKLOG; i++) f.bulkPost("commons", `backlog-${i}`);
  const head = f.store.room("commons").sequence;
  const laggard = await f.openReading("commons", f.keys.commons, start);
  const peer = await f.openReading("commons", f.keys.commons, head);
  const postedAt = Date.now();
  const live = f.post("commons", "live-during-catchup").sequence;
  await f.waitFor(() => peer.ids().includes(live), 30000, "peer to receive the live event");
  const waited = Date.now() - postedAt;
  const bound = (Math.ceil(BACKLOG / 100) + 2) * interval + 15000;
  assert.ok(waited < bound, `peer waited ${waited}ms for a live event during a ${BACKLOG}-row catch-up (bound ${bound}ms)`);
  assert.deepEqual(peer.ids(), [live], "peer got exactly the live event, once");
  await f.waitFor(() => laggard.ids().length >= BACKLOG + 1, 30000, "laggard to converge");
  assert.deepEqual(laggard.ids(), range(start + 1, head + 1), "laggard converges to the exact full window");
});

test("abruptly destroyed sockets are pruned and free their per-credential slots", async t => {
  // Contract: dead sockets are pruned (close event or the pump's destroyed
  // check) so the 3-stream cap counts live streams only. Regression: a pump
  // that only cleans up on graceful close leaks slots on TCP death (proxies,
  // NAT timeouts, killed clients) until the 100-stream pool wedges.
  // tests/stream-lifecycle.test.js covers graceful abort; this covers RST.
  const f = await fixture(t, { streamInterval: 25 });
  const key = f.store.issueAccessKey("commons", "owner");
  const head = f.store.room("commons").sequence;
  const dead = [];
  for (let i = 0; i < 3; i++) {
    const opened = await openRaw(f.origin, "commons", key, head, f.sockets);
    assert.equal(opened.status, 200);
    dead.push(opened.socket);
  }
  for (const socket of dead) socket.destroy(); // TCP death, no HTTP close
  let reopened = null;
  for (let attempt = 0; attempt < 40 && !reopened; attempt++) {
    await sleep(50);
    const probe = await openRaw(f.origin, "commons", key, head, f.sockets);
    if (probe.status === 200) reopened = probe; else probe.socket.destroy();
  }
  assert.ok(reopened, "a slot freed up after the TCP deaths were pruned");
  const more = [];
  for (let i = 0; i < 2; i++) {
    const opened = await openRaw(f.origin, "commons", key, head, f.sockets);
    more.push(opened);
  }
  assert.ok(more.every(m => m.status === 200), "the credential is back to its full 3-stream allowance");
  const capped = await openRaw(f.origin, "commons", key, head, f.sockets);
  assert.equal(capped.status, 429, "the per-credential cap still enforced after pruning");
  capped.socket.destroy();
});

// ---------------------------------------------------------------------------
// PART B — fail-first shared-pump architecture pins (fail until W2 lands)
// ---------------------------------------------------------------------------
// The F1 design (docs/WAVE300-FANOUT-DESIGN.md, refined by W1): one interval
// per roomId; each tick fetches new events ONCE since the room's minimum
// stream cursor — via store.eventsAfter with { includeInvisible: true } so
// the shared page is the union of every stream's visible rows — then fans
// out per stream with the per-viewer filter. These tests pin that contract
// and FAIL on the current per-stream architecture, for the intended reason
// (N fetches per tick instead of one). They must go green when W2 lands.

function wrapEventsAfter(store) {
  const calls = [];
  const original = store.eventsAfter.bind(store);
  store.eventsAfter = (...args) => { calls.push({ at: Date.now(), args }); return original(...args); };
  return calls;
}

test("F1: one eventsAfter fetch per room per tick regardless of stream count", async t => {
  const interval = 50;
  const f = await fixture(t, { streamInterval: interval });
  const calls = wrapEventsAfter(f.store);
  const head = f.store.room("commons").sequence;
  for (let i = 0; i < 3; i++) await f.openReading("commons", f.keys.commons, head);
  const measureFrom = Date.now();
  await sleep(1050);
  const elapsed = Date.now() - measureFrom;
  const tickCalls = calls.filter(c => c.at >= measureFrom);
  const maxTicks = Math.floor(elapsed / interval) + 2; // +2 for timer jitter
  assert.ok(tickCalls.length >= 10, `enough ticks ran to measure (saw ${tickCalls.length} fetches)`);
  assert.ok(tickCalls.length <= maxTicks,
    `shared pump fetches once per tick: ${tickCalls.length} eventsAfter calls over ~${Math.floor(elapsed / interval)} ticks (max ${maxTicks})`);
});

test("F1: the shared fetch rides the minimum stream cursor and skips the per-viewer filter", async t => {
  // Contract: each tick's single fetch uses after = min(live stream cursors)
  // so a far-behind stream's rows are never skipped, and it carries
  // { includeInvisible: true } so the page is the union of every stream's
  // visible rows. Regression: fetching from the max cursor (or any single
  // stream's view) would starve the laggard / break the union.
  //
  // Deterministic without timing assumptions: while the laggard is behind,
  // every shared fetch must advance `after` by exactly one 100-row page from
  // a start-aligned base and must stay below the ahead stream's cursor; once
  // the laggard catches up the fetch parks at the room head. We assert on
  // the below-head prefix of the observed ticks, however long setup took.
  const interval = 200;
  const f = await fixture(t, { streamInterval: interval });
  const calls = wrapEventsAfter(f.store);
  const start = f.store.room("commons").sequence;
  f.store.transaction(() => { for (let i = 0; i < 600; i++) f.bulkPost("commons", `backlog-${i}`); });
  const highKey = f.addAgent("commons").key; // member.added lands after the backlog
  const top = f.store.room("commons").sequence;
  const low = await f.openReading("commons", f.keys.commons, start);
  const high = await f.openReading("commons", highKey, top);
  const measureFrom = Date.now();
  await sleep(interval * 3 + 150);
  const tickCalls = calls.filter(c => c.at >= measureFrom);
  assert.ok(tickCalls.length >= 2, `enough shared ticks ran to measure (saw ${tickCalls.length})`);
  const afters = tickCalls.map(c => c.args[2]);
  const belowHead = afters.filter(after => after < top);
  assert.ok(belowHead.length >= 1, `at least one shared tick rode the laggard's cursor (afters=${afters.join(",")}, top=${top})`);
  for (let i = 1; i < afters.length; i++)
    assert.ok(afters[i] >= afters[i - 1], `shared fetch cursors never go backwards (${afters.join(",")})`);
  for (const after of belowHead)
    assert.equal((after - start) % 100, 0, `laggard-phase fetch tracks a page-aligned cursor (after=${after}, start=${start})`);
  for (let i = 1; i < belowHead.length; i++)
    assert.equal(belowHead[i] - belowHead[i - 1], 100, `laggard advances exactly one page per shared tick (${belowHead.join(",")})`);
  // W1 refined design: the shared page is the UNION of every stream's
  // visible rows, so the fetch carries { includeInvisible: true } (6th arg).
  assert.ok(tickCalls.every(c => c.args[4]?.includeInvisible === true || c.args[5]?.includeInvisible === true),
    "every shared fetch carries { includeInvisible: true }");
  await f.waitFor(() => low.ids().length >= 300, 20000, "far-behind stream to receive from the shared page");
});

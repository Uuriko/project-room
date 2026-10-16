import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { event, EVENT_TYPES as T } from "../src/events.js";
import { redactEventPage } from "../server/redact-read.mjs";

// PERF-10X L12 (VIS-C, 09c §5): the SSE pump's two micro-fixes.
//  1. An idle tick (empty event page) builds no redaction view at all:
//     zero redactionMessages() calls, zero views built, zero statements
//     spent inside redaction while ticks keep running.
//  2. A non-empty tick reuses the cached view per (room, latest sequence):
//     a burst delivered to N streams builds the view once, not N times.
// Delivery equivalence (every stream receives every burst frame) and
// redaction correctness (a message redacted between ticks is never
// delivered unredacted from a cached view) are the regression gates.
//
// Statement counting follows VIS-C's harness shape: a wrapper on
// db.prepare counts every run/get/all execution on statements prepared
// through it. Statements the store cached before instrumentation bypass
// the wrapper, so the two room() statement caches are dropped first;
// counts remain a floor, exactly as VIS-C labelled its Node counts.

function instrument(store) {
  const counts = { statements: 0, eventsAfterCalls: 0, redactionCalls: 0, redactionStatements: 0, views: new Set() };
  const prepare = store.db.prepare.bind(store.db);
  store.db.prepare = sql => {
    const stmt = prepare(sql);
    for (const method of ["run", "get", "all"]) {
      if (typeof stmt[method] !== "function") continue;
      const fn = stmt[method].bind(stmt);
      stmt[method] = (...args) => { counts.statements++; return fn(...args); };
    }
    return stmt;
  };
  store._roomSequenceStmt = undefined;
  store._roomProjectionStmt = undefined;
  const eventsAfter = store.eventsAfter.bind(store);
  store.eventsAfter = (...args) => { counts.eventsAfterCalls++; return eventsAfter(...args); };
  const redactionMessages = store.redactionMessages.bind(store);
  store.redactionMessages = (...args) => {
    counts.redactionCalls++;
    const before = counts.statements;
    const view = redactionMessages(...args);
    counts.redactionStatements += counts.statements - before;
    counts.views.add(view);
    return view;
  };
  counts.reset = () => {
    counts.statements = 0; counts.eventsAfterCalls = 0;
    counts.redactionCalls = 0; counts.redactionStatements = 0; counts.views = new Set();
  };
  return counts;
}

async function serve(t, { seedMessages = 0, streamInterval = 50 } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "stream-pump-redaction-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const events = [...initialRoom()];
  for (let i = 0; i < seedMessages; i++) {
    events.push(event({ type: T.MESSAGE_POSTED, actorId: "owner", roomId: "commons",
      id: `seed-${i}`, data: { messageId: `seed-${i}`, body: `seed body ${i} ${"x".repeat(120)}` } }));
  }
  store.initialize(events);
  const server = createRoomServer({ store, streamInterval });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const readers = [];
  t.after(async () => {
    for (const reader of readers) await reader.cancel().catch(() => {});
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close(); rmSync(directory, { recursive: true, force: true });
  });
  async function openStream(key, after) {
    const response = await fetch(`${origin}/api/rooms/commons/stream?after=${after}`, { headers: { Authorization: `Bearer ${key}` } });
    assert.equal(response.status, 200);
    const reader = response.body.getReader(); readers.push(reader);
    const received = { text: "" };
    (async () => {
      const decoder = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) return; received.text += decoder.decode(value, { stream: true }); }
    })().catch(() => {});
    return received;
  }
  return { store, origin, openStream };
}

// room-event frames of one stream, in arrival order: [{ sequence, body }]
function frames(received) {
  const out = [];
  for (const block of received.text.split("\n\n")) {
    if (!block.includes("event: room-event")) continue;
    const data = block.split("\n").find(line => line.startsWith("data: "));
    if (!data) continue;
    const item = JSON.parse(data.slice(6));
    out.push({ sequence: item.sequence, body: item.event?.data?.body, type: item.event?.type, messageId: item.event?.data?.messageId });
  }
  return out;
}

async function waitFor(label, condition, timeoutMs = 5000) {
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await sleep(25);
  }
}

test("idle pump ticks build no redaction view and spend no statements on redaction", async t => {
  const { store, openStream } = await serve(t, { seedMessages: 120 });
  const counts = instrument(store);
  const head = store.room("commons").sequence;
  // mintAccessKey (not issueAccessKey): issuing must not revoke the keys
  // the already-open streams are using.
  const streams = [];
  for (let i = 0; i < 4; i++) streams.push(await openStream(store.mintAccessKey("commons", "owner"), head));
  await waitFor("initial heartbeats", () => streams.every(s => s.text.includes(": connected transport only")));
  counts.reset();
  await sleep(900);
  // The ticks really ran: each tick is one eventsAfter call, and each
  // stream kept receiving heartbeat comment frames.
  assert.ok(counts.eventsAfterCalls >= 8, `expected many idle ticks, saw ${counts.eventsAfterCalls}`);
  for (const [index, stream] of streams.entries()) {
    assert.ok((stream.text.match(/: connected transport only/g) ?? []).length >= 3, `stream ${index} kept receiving idle heartbeats`);
    assert.equal(stream.text.includes("access-ended"), false, `stream ${index} stayed open for the whole window`);
  }
  assert.ok(counts.statements > 0, "the statement counter is live (eventsAfter still does its per-tick reads)");
  // Fix 1: on empty pages the redaction view is never built — no calls, no
  // view, no statements inside redaction, and therefore no O(messages)
  // spread of the 120-message room per tick. Before the fix every one of
  // these ticks called redactionMessages() once per stream.
  assert.equal(counts.redactionCalls, 0, "idle ticks must not call redactionMessages");
  assert.equal(counts.views.size, 0, "idle ticks must not build a redaction view");
  assert.equal(counts.redactionStatements, 0, "idle ticks must spend no statements inside redaction");
  t.diagnostic(`idle window: ${counts.eventsAfterCalls} ticks, ${counts.statements} statements total (all eventsAfter's own; the event-driven pump that removes those is the post-freeze CALL 4 build), 0 redaction calls`);
});

test("burst delivery: every stream receives every frame, and the redaction view is built once for the burst", async t => {
  const { store, openStream } = await serve(t);
  const counts = instrument(store);
  const owner = store.mintAccessKey("commons", "owner");
  const head = store.room("commons").sequence;
  const streams = [];
  for (let i = 0; i < 8; i++) streams.push(await openStream(store.mintAccessKey("commons", "owner"), head));
  await waitFor("streams open", () => streams.every(s => s.text.length > 0));
  counts.reset();
  // Synchronous loop: no pump tick can interleave between the posts, so
  // every stream's next tick sees the same 10-event page at one sequence.
  const sequences = [];
  for (let i = 0; i < 10; i++) {
    sequences.push(store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: `burst-${i}`, body: `burst body ${i}` } }).sequence);
  }
  await waitFor("all streams to receive the whole burst", () => streams.every(s => frames(s).length >= 10));
  for (const [index, stream] of streams.entries()) {
    const got = frames(stream).filter(frame => sequences.includes(frame.sequence));
    assert.deepEqual(got.map(f => f.sequence), sequences, `stream ${index} received every burst frame in order`);
    assert.deepEqual(got.map(f => f.body), sequences.map((_, i) => `burst body ${i}`), `stream ${index} received every burst body`);
  }
  // Fix 2: the burst was redacted against one shared view, not one spread
  // of the room's messages per stream per tick.
  assert.ok(counts.redactionCalls >= 1, "the burst page was redacted");
  assert.equal(counts.views.size, 1, `expected one redaction view build for the burst, saw ${counts.views.size}`);
  t.diagnostic(`burst: ${counts.redactionCalls} redaction calls across 8 streams, ${counts.views.size} view build(s)`);
});

test("a message deleted between ticks is never delivered unredacted to a stream replaying from a cached view", async t => {
  const { store, openStream } = await serve(t);
  const owner = store.issueAccessKey("commons", "owner");
  const SECRET = "pump-secret-9d41";
  const posted = store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_POSTED, data: { messageId: "victim", body: SECRET } });
  // Stream A delivers the message while it is live; this builds and caches
  // the redaction view at that sequence — the view a stale cache would
  // keep serving from.
  const a = await openStream(owner, posted.sequence - 1);
  await waitFor("stream A to deliver the live message", () => frames(a).some(f => f.sequence === posted.sequence && f.body === SECRET));
  store.command(owner, "commons", { id: randomUUID(), type: T.MESSAGE_DELETED, data: { messageId: "victim", expectedMessageRevision: 0, reason: "withdrawn" } });
  // Stream B connects after the deletion and replays the same window
  // (Last-Event-ID resume shape). It must get the tombstone, never the
  // body the cached view was built from.
  const bKey = store.mintAccessKey("commons", "owner");
  const b = await openStream(bKey, posted.sequence - 1);
  await waitFor("stream B to replay the window", () => frames(b).some(f => f.sequence === posted.sequence));
  const replayed = frames(b).find(f => f.sequence === posted.sequence);
  assert.equal(replayed.body, null, "the replayed frame is the tombstone");
  assert.equal(b.text.includes(SECRET), false, "the secret never reaches stream B");
});

test("redaction view cache: same view while unchanged, rebuilt on edit and on delete", t => {
  const directory = mkdtempSync(join(tmpdir(), "redaction-view-cache-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  cmd(T.MESSAGE_POSTED, { messageId: "target", body: "cache-original-51aa" });
  const first = store.redactionMessages("commons");
  assert.equal(store.redactionMessages("commons"), first, "an unchanged room reuses the cached view (no second spread)");
  const page = () => redactEventPage(store.eventsAfter(owner, "commons", 0, 100), store.redactionMessages("commons"));
  const bodyOf = () => page().events.find(entry => entry.event.data?.messageId === "target" && Object.hasOwn(entry.event.data, "body"))?.event.data.body;
  assert.equal(bodyOf(), "cache-original-51aa");
  cmd(T.MESSAGE_EDITED, { messageId: "target", body: "cache-edited-51ab", expectedMessageRevision: 0 });
  assert.notEqual(store.redactionMessages("commons"), first, "an edit rebuilds the view");
  assert.equal(bodyOf(), "cache-edited-51ab", "the edited body is the current one");
  const edited = store.redactionMessages("commons");
  cmd(T.MESSAGE_DELETED, { messageId: "target", expectedMessageRevision: 1, reason: "withdrawn" });
  assert.notEqual(store.redactionMessages("commons"), edited, "a delete rebuilds the view");
  assert.equal(bodyOf(), null, "a deleted message redacts to the tombstone from the rebuilt view");
});

test("redaction view cache: a same-sequence projection rewrite invalidates the view (archive-shape write)", t => {
  const directory = mkdtempSync(join(tmpdir(), "redaction-view-sameseq-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  cmd(T.MESSAGE_POSTED, { messageId: "target", body: "sameseq-live-77c0" });
  const before = store.redactionMessages("commons");
  const sequence = store.room("commons").sequence;
  // archiveRoomMessages / restoreArchivedMessage(s) / rehydrate rewrite
  // rooms.projection WITHOUT bumping the room sequence (see
  // server/messages-store.mjs). A sequence-only cache key would keep
  // serving the pre-rewrite view here; the identity key must not.
  const row = store.db.prepare("SELECT projection FROM rooms WHERE id='commons'").get();
  const projection = JSON.parse(row.projection);
  const message = projection.messages.find(m => m.id === "target");
  message.body = null; message.deletedAt = "2026-10-16T00:00:00.000Z";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='commons'").run(JSON.stringify(projection));
  assert.equal(store.room("commons").sequence, sequence, "the rewrite kept the sequence — that is the hazard");
  const after = store.redactionMessages("commons");
  assert.notEqual(after, before, "the view is rebuilt after a same-sequence projection rewrite");
  const out = redactEventPage({ events: [{ sequence: 1, event: { type: T.MESSAGE_POSTED, id: "target", data: { messageId: "target", body: "sameseq-live-77c0" } } }] }, after);
  assert.equal(out.events[0].event.data.body, null, "the rewritten (redacted) record is what the new view serves");
});

test("redaction view cache: an archived message redacted without a sequence bump is never served from the cached view", t => {
  const directory = mkdtempSync(join(tmpdir(), "redaction-view-archived-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const owner = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(owner, "commons", { id: randomUUID(), type, data });
  const SECRET = "archived-secret-30be";
  cmd(T.MESSAGE_POSTED, { messageId: "arch-target", body: SECRET });
  for (let i = 0; i < 6; i++) cmd(T.MESSAGE_POSTED, { messageId: `pad-${i}`, body: `pad ${i}` });
  for (let i = 0; i < 20 && !store.backfillMessages({ limit: 1000 }).done; i++) {}
  store.checkMessagesParity();
  const archived = store.archiveMessages("commons", { keepNewest: 2, dryRun: false });
  assert.ok(archived.archived > 0 && !store.room("commons").state.messages.some(m => m.id === "arch-target"), "the target is archived out of the projection");
  const sequence = store.room("commons").sequence;
  // Build (and cache) the view. The archived record is reached only
  // through the view's archivedLookup.
  const view = store.redactionMessages("commons");
  const synthetic = () => ({ events: [{ sequence: 1, event: { type: T.MESSAGE_POSTED, id: "arch-target", data: { messageId: "arch-target", body: SECRET } } }] });
  assert.equal(redactEventPage(synthetic(), view).events[0].event.data.body, SECRET, "a live archived message keeps its body");
  // The no-sequence-bump redaction: commitMessageRedaction on an archived
  // room and account deletion's archived-row clear both rewrite the
  // messages row directly (body/record_json nulled) without touching
  // rooms.sequence or the projection. Mirror that write here.
  store.db.prepare("UPDATE messages SET body=NULL, record_json=NULL, deleted_at=COALESCE(deleted_at, ?) WHERE room_id='commons' AND message_id='arch-target'")
    .run("2026-10-16T00:00:00.000Z");
  assert.equal(store.room("commons").sequence, sequence, "the redaction did not bump the sequence");
  assert.equal(store.redactionMessages("commons"), view, "the cached view is (legitimately) reused — its archived lookup must still be live");
  assert.equal(redactEventPage(synthetic(), view).events[0].event.data.body, null,
    "the redacted archived message redacts to the tombstone even from the cached view");
});

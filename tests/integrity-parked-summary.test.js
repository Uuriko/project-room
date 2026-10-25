import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";
import { JOBS, HOUR_MS } from "../server/jobs.mjs";
import { runCronJobs, applyOutcomes, jobHealthView } from "../cloudflare/job-heartbeat.mjs";

// CURE-INTEGRITY-SCAN: a room parked by the messages backfill is
// unscannable, not a failed verification. Before this cure, its durable
// per-room failure record failed every integrity tick for as long as the
// park lasted — production: 156 consecutive failed ticks over 7.8 days
// (last success 2026-10-11) with `verified` reading 0, while every
// scannable room stood verified. These tests pin the cured contract:
// the parked set rides the summary as its own numbers (blockedRooms,
// blockedFailures, blockedSince) beside a verified-rooms count for the
// scannable rooms; the tick's verdict is the scannable rooms'; a real
// verification failure still fails the tick and is named ahead of any
// parked room.
//
// NARROWED at the C6 reconcile (PART1-4250-NARROWED-SPEC.md): the
// partition covers EVENT parks only (the durable block carries the
// event's id). A LOG-GAP park — the log ends before the room's head,
// the block carries event_id NULL with reason log_short — stays FATAL
// under main's deliberate post-#4758 contract: no code synthesises
// missing events, and a truncated log is data loss, not a stall. Test 5
// pins that side; tests/integrity-block-health.test.js (main's version,
// untouched) pins it again from the health surface.

const integrity = JOBS.find(job => job.name === "integrity");

const at = offset => new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
const messageEvent = (roomId, id, data, offset) => event({
  type: T.MESSAGE_POSTED, actorId: "owner", roomId, id,
  idempotencyKey: `${id}-key`, at: at(offset), data
});

function healthyRoom(store, roomId, offset) {
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, `ev-${roomId}-1`, { messageId: `${roomId}-m1`, body: "first" }, offset),
    messageEvent(roomId, `ev-${roomId}-2`, { messageId: `${roomId}-m2`, body: "second" }, offset + 1)
  ]);
}

// The established poison shape (tests/messages-backfill-blocks.test.js):
// a stored event whose messageId the current envelope validator rejects,
// with the projection rewritten to match, the way a legacy writer left it.
//
// FIXTURE REBUILT at the narrowed build (spec §5, execution question
// (a)): on current main a poisoned event ahead of the cursor is
// QUARANTINED by the heal (skipped=1) and never stands as a park, so
// the original shape reached no parked steady state. The standing park
// this suite pins is the below-cursor one: the room is applied and
// certified first, the already-applied event is poisoned in place, the
// head moves with a live post, and the park is recorded the way a
// from-zero diagnosis recorded it before diagnoseFreshBlock existed —
// the named event sits at or below the cursor snapshot, so the heal
// leaves the row skipped=0 (messages-store.mjs: healBackfillQuarantines
// converts only blocks ahead of the cursor).
function poisonedRoom(store, roomId) {
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, "ev-standin", { messageId: "standin", body: "legacy text" }, 10),
    messageEvent(roomId, "ev-tail", { messageId: "tail", body: "after the poison" }, 11)
  ]);
  // Apply and certify the room as written, so the poisoned event is
  // already applied and the cursor snapshot sits at the head.
  store.backfillMessages({ limit: 1000 });
  store.checkMessagesParity({ roomId });
  const poisonSeq = store.db.prepare("SELECT sequence FROM events WHERE id='ev-standin'").get().sequence;
  const row = store.db.prepare("SELECT sequence, body FROM events WHERE id='ev-standin'").get();
  const stored = JSON.parse(row.body);
  stored.data.messageId = "bad id@x";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(stored));
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === "standin").id = "bad id@x";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
  // The messages table publishes the serving projection's copy, so the
  // table and the projection stay in parity; the log alone disagrees.
  store.db.prepare("UPDATE messages SET message_id='bad id@x' WHERE room_id=? AND message_id='standin'").run(roomId);
  // Move the head: a live post lands on the room while it is parked, so
  // the parked room is behind its head and never counts as verified.
  const key = store.issueAccessKey(roomId, "owner");
  store.command(key, roomId, { id: "ev-aaa-3", type: "message.posted", data: { messageId: "aaa-m3", body: "posted after the poison" } });
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  const now = Date.now();
  store.db.prepare(`INSERT INTO messages_backfill_blocks
      (room_id, sequence, event_id, error, head_seq, blocked_at, last_diagnosed_at, reason, component, attempts, skipped, anchor_seq)
    VALUES (?, ?, 'ev-standin', 'Invalid messageId', ?, ?, ?, 'reducer_rejected', 'messages', 1, 0, -1)`)
    .run(roomId, poisonSeq, head, now, now);
  // The parking diagnosis recorded the room's failure durably in the
  // same act (the wrapper's record for a standing block); the job's
  // first tick must already see the record standing.
  store.recordIntegrityFailure("messages_backfill", roomId, new Error("Invalid messageId"));
}

function openFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-integrity-parked-summary-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { integrity: "deferred" });
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  poisonedRoom(store, "aaa");
  healthyRoom(store, "mid", 20);
  healthyRoom(store, "zzz", 30);
  return store;
}

const tick = store => integrity.run(store, { deadline: Date.now() + 5000 });
const summaryFailed = result => Boolean(result.scanError) || Number(result.errors) > 0;

// Drive the job until the park is recorded and both healthy rooms are
// parity-certified; returns the steady-state tick result.
async function settleParked(store) {
  let result = null;
  for (let i = 0; i < 24; i++) {
    result = await tick(store);
    assert.ok(!summaryFailed(result), `tick ${i + 1} must not fail while only a park is outstanding`);
    if (result.blockedFailures === 1 && result.verifiedRooms === 2) return result;
  }
  assert.fail("the fixture never reached the parked steady state");
}

test("a parked room does not fail the tick; verified rooms and the blocked set are distinct numbers", async t => {
  const store = openFixture(t);
  const steady = await settleParked(store);
  assert.equal(steady.errors, undefined);
  assert.equal(steady.scanError, undefined);
  assert.equal(steady.failureDetail, undefined);
  assert.equal(steady.blockedRooms, 1, "the standing block count from the durable table");
  assert.equal(steady.blockedFailures, 1, "the parked set as its own summary number");
  assert.equal(steady.verifiedRooms, 2, "both scannable rooms verified at head; the parked room is not counted");
  const record = store.integrityFailures().find(failure => failure.step === "messages_backfill");
  assert.ok(record, "the parked room keeps its durable failure record — it still reads blocked");
  assert.equal(record.recordId, "aaa", "the record carries the room's identity");
  assert.equal(record.code, "messages_backfill_failed");
  assert.equal(steady.blockedSince, record.firstSeenAt, "the summary names the wedge's age from the record's first sighting");
  // The healthy rooms really are verified, not merely uncounted failures.
  for (const roomId of ["mid", "zzz"]) {
    const cursor = store.db.prepare("SELECT applied_seq, parity_at_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
    const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
    assert.equal(cursor.applied_seq, head);
    assert.equal(cursor.parity_at_seq, head);
  }
});

test("worker health over a parked store: success clock advances, summary carries the blocked set, no block evidence leaks", async t => {
  const store = openFixture(t);
  let at = Date.now();
  let stored = {};
  let view = null;
  for (let i = 0; i < 24; i++) {
    at += HOUR_MS;
    const outcomes = await runCronJobs({ integrity: () => integrity.run(store, {
      room: { verifyRoomIntegrity: () => store.verifyRoomIntegrity({ deadline: Date.now() + 5000 }) }
    }) }, { now: () => at, log() {} });
    stored = applyOutcomes(stored, outcomes);
    view = jobHealthView(stored, at).jobs.find(job => job.name === "integrity");
    assert.equal(view.consecutiveFailures, 0, "no tick fails while only the park is outstanding");
    if (view.lastSummary?.blockedFailures === 1 && view.lastSummary?.verifiedRooms === 2) break;
  }
  assert.equal(view.status, "ok");
  assert.equal(view.lastSuccessAt, new Date(at).toISOString(), "the success clock advances every tick");
  assert.equal(view.lastSummary.blockedRooms, 1);
  assert.equal(view.lastSummary.blockedFailures, 1);
  assert.equal(view.lastSummary.verifiedRooms, 2);
  assert.ok(Number.isFinite(view.lastSummary.blockedSince), "the wedge's age is visible in the envelope");
  assert.equal(view.lastErrorCode, null);
  assert.ok(!JSON.stringify(view).includes("ev-standin"), "public health must not contain block evidence");
});

test("a real parity failure still fails the tick and is named ahead of the parked room", async t => {
  const store = openFixture(t);
  await settleParked(store);
  // Tamper with a scannable room's certified messages table: the parity
  // sweep must catch it, and that verdict — not the park — owns the tick.
  store.db.prepare("DELETE FROM messages WHERE room_id='mid' AND message_id='mid-m1'").run();
  let failing = null;
  for (let i = 0; i < 24 && !failing; i++) {
    const result = await tick(store);
    if (summaryFailed(result)) failing = result;
  }
  assert.ok(failing, "the parity failure fails the tick");
  assert.equal(failing.errors, 1, "only the fatal failure is counted as an error");
  assert.equal(failing.failureDetail.subcheck, "messages_parity");
  assert.equal(failing.failureDetail.recordId, "mid", "the detail names the room that failed verification, not the parked room");
  assert.equal(failing.blockedFailures, 1, "the parked set still rides the failing summary as its own number");
  assert.equal(failing.blockedRooms, 1);
  assert.equal(failing.verifiedRooms, 1, "the tampered room's certification was revoked; one healthy room remains verified");
});

test("repairing the parked room clears the blocked numbers and verifies the room", async t => {
  const store = openFixture(t);
  await settleParked(store);
  // In-place repair of the named event (the operator path), then the
  // existing import repair clears the park.
  const row = store.db.prepare("SELECT body FROM events WHERE id='ev-standin'").get();
  const storedEvent = JSON.parse(row.body);
  storedEvent.data.messageId = "standin";
  store.db.prepare("UPDATE events SET body=? WHERE id='ev-standin'").run(JSON.stringify(storedEvent));
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id='aaa'").get();
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === "bad id@x").id = "standin";
  store.db.prepare("UPDATE rooms SET projection=? WHERE id='aaa'").run(JSON.stringify(projection));
  const key = store.issueAccessKey("aaa", "owner");
  const lines = store.db.prepare("SELECT sequence, body FROM events WHERE room_id='aaa' ORDER BY sequence").all()
    .map(line => ({ sequence: line.sequence, event: JSON.parse(line.body) }));
  store.importEvents(key, "aaa", lines);
  let recovered = null;
  for (let i = 0; i < 24 && !recovered; i++) {
    const result = await tick(store);
    assert.ok(!summaryFailed(result), "no tick fails during recovery");
    if (result.blockedRooms === 0 && result.blockedFailures === undefined && result.verifiedRooms === 3) recovered = result;
  }
  assert.ok(recovered, "the repaired room backfills, certifies, and the blocked numbers clear");
  assert.deepEqual(store.integrityFailures(), [], "no failure records remain outstanding");
});

test("a log-gap park still fails the tick: the narrowed partition keeps main's post-#4758 contract", async t => {
  // Build the gap on a fresh store so the fixture's parked rooms
  // cannot mask the verdict.
  const directory = mkdtempSync(join(tmpdir(), "room-integrity-parked-summary-gap-"));
  const gapStore = new RoomStore(join(directory, "room.sqlite"), { integrity: "deferred" });
  t.after(() => { gapStore.close(); rmSync(directory, { recursive: true, force: true }); });
  healthyRoom(gapStore, "gaproom", 40);
  healthyRoom(gapStore, "witness", 50);
  // Truncate the log relative to the head: the room's stored sequence
  // now claims events the log does not contain — diagnoseBlock's gap
  // shape (event_id NULL, reason log_short, skipped 0). No code
  // synthesises the missing tail, so this park is data loss, and the
  // narrowed partition must leave it in the fatal set.
  gapStore.db.prepare("UPDATE rooms SET sequence = sequence + 3 WHERE id='gaproom'").run();
  let failing = null;
  for (let i = 0; i < 24 && !failing; i++) {
    const result = await tick(gapStore);
    if (summaryFailed(result)) failing = result;
  }
  assert.ok(failing, "the log-gap park fails the tick");
  assert.equal(failing.failureDetail.subcheck, "messages_backfill");
  assert.equal(failing.failureDetail.recordId, "gaproom", "the detail names the gap room");
  assert.equal(failing.blockedFailures, undefined, "a log-gap park is fatal, never partitioned into the blocked numbers");
  const record = gapStore.integrityFailures().find(failure => failure.step === "messages_backfill" && failure.recordId === "gaproom");
  assert.ok(record, "the gap park keeps its durable failure record");
  assert.match(record.message, /^messages backfill stopped at /, "the record carries the allowlisted backfill-stop line");
  const block = gapStore.db.prepare("SELECT event_id, reason, skipped FROM messages_backfill_blocks WHERE room_id='gaproom'").get();
  assert.equal(block.event_id, null, "the gap block carries no event id — the partition's carve-out signal");
  assert.equal(block.reason, "log_short");
  assert.equal(block.skipped, 0);
});

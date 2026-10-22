import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";

// Issue #3904 (bug sweep 2026-10-16, lane 02 MESSAGES-INTEGRITY), the two
// Low findings:
//
// F4 — re-diagnosis of parked rooms ran unbounded full-log replays outside
// the batch budget. The periodic re-diagnosis cadence already honors the
// caller's deadline, but the head-moved path in refreshStaleBlocks did
// not: every parked room whose head moved earned a re-diagnosis before
// the deadline-aware fill loop, a torn/unusable cursor snapshot makes
// that diagnosis a full replay from sequence 0 (diagnoseBlock), and
// neither the refresh loop nor diagnoseBlock itself ever looked at the
// deadline — so N live parked rooms multiplied one tick's budget by N
// full replays. The fix threads the deadline through refreshStaleBlocks
// and the diagnosis functions: a diagnosis that reaches the deadline
// aborts and leaves the block row untouched (the room stays parked and
// is re-diagnosed on a later call), and the refresh stops for the call.
//
// F5 — when two rooms parked in one backfill call, only the first got
// the one-time named-failure surface. At current main the lossy throw is
// gone: runIntegrityBackfillStep records EVERY standing block as a
// durable per-room integrity failure. The F5 specimen below is the
// executed proof-of-gone: it passes at the pre-fix head and pins the
// behaviour so the loss cannot return silently.

function open(t) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  return store;
}

function at(offset) {
  return new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
}

function messageEvent(roomId, id, type, data, offset) {
  return event({
    type, actorId: "owner", roomId, id, idempotencyKey: `${id}-key`, at: at(offset), data
  });
}

function rows(store, roomId) {
  return store.db.prepare("SELECT * FROM messages WHERE room_id=? ORDER BY message_id").all(roomId);
}

function blockRow(store, roomId) {
  const row = store.db.prepare("SELECT * FROM messages_backfill_blocks WHERE room_id=?").get(roomId);
  return row ? { ...row } : null;
}

function poisonEvent(store, roomId, eventId, standinId, poisonId) {
  const row = store.db.prepare("SELECT sequence, body FROM events WHERE id=?").get(eventId);
  const stored = JSON.parse(row.body);
  stored.data.messageId = poisonId;
  store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(stored), eventId);
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === standinId).id = poisonId;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
  return row.sequence;
}

function repairInPlace(store, roomId, eventId, poisonId, fixedId) {
  const row = store.db.prepare("SELECT body FROM events WHERE id=?").get(eventId);
  const stored = JSON.parse(row.body);
  stored.data.messageId = fixedId;
  store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(stored), eventId);
  const roomRow = store.db.prepare("SELECT projection FROM rooms WHERE id=?").get(roomId);
  const projection = JSON.parse(roomRow.projection);
  projection.messages.find(message => message.id === poisonId).id = fixedId;
  store.db.prepare("UPDATE rooms SET projection=? WHERE id=?").run(JSON.stringify(projection), roomId);
}

// A room whose poison sits at the END of a long log: the fill reaches it
// only after committing every earlier chunk, and a re-diagnosis that
// cannot use the cursor snapshot must replay the whole log to reach it —
// the expensive diagnosis shape F4 is about. The event count stays under
// the backfill's per-call cap so one call parks the room.
const BIG_TAILS = 950;

function bigPoisonedRoom(store, roomId) {
  const seed = [...initialRoom(roomId)];
  for (let i = 0; i < BIG_TAILS; i += 1) {
    seed.push(messageEvent(roomId, `ev-${roomId}-t${i}`, T.MESSAGE_POSTED, { messageId: `t${i}`, body: `line ${i}` }, 20 + i));
  }
  seed.push(messageEvent(roomId, `ev-poison-${roomId}`, T.MESSAGE_POSTED, { messageId: "standin", body: "legacy text" }, 20 + BIG_TAILS));
  store.initialize(seed);
  return poisonEvent(store, roomId, `ev-poison-${roomId}`, "standin", "bad id@x");
}

// Remove the resume snapshot a diagnosis would have used, the torn state
// the diagnosis code itself anticipates (decode failure / missing
// snapshot falls back to a full replay from sequence 0).
function tearSnapshot(store, roomId) {
  store.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id=?").run(roomId);
}

// Move a parked room's head with one ordinary message through the command
// path (projection and log advance together, the way live traffic does).
function moveHead(store, roomId, tag) {
  const key = store.issueAccessKey(roomId, "owner");
  store.command(key, roomId, {
    id: `ev-headmove-${tag}`, type: T.MESSAGE_POSTED,
    data: { messageId: `headmove-${tag}`, body: "still receiving traffic" }
  });
}

test("F4: head-moved re-diagnoses honor the deadline and defer untouched", t => {
  const store = open(t);
  bigPoisonedRoom(store, "aaa");
  bigPoisonedRoom(store, "bbb");
  const parked = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(parked.blocked.map(block => block.roomId), ["aaa", "bbb"],
    "both rooms park in the seeding call");

  tearSnapshot(store, "aaa");
  tearSnapshot(store, "bbb");
  moveHead(store, "aaa", "a");
  moveHead(store, "bbb", "b");
  const aaaParked = blockRow(store, "aaa");
  const bbbParked = blockRow(store, "bbb");
  const newHead = roomId => store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  assert.ok(newHead("aaa") !== aaaParked.head_seq && newHead("bbb") !== bbbParked.head_seq,
    "fixture: both heads moved past the recorded blocks");

  // A deadline far below one full re-diagnosis of either room (~950
  // events replayed from sequence 0 with no usable snapshot).
  const starved = store.backfillMessages({ limit: 1000, deadline: Date.now() + 30 });
  assert.equal(starved.budgetExceeded, true, "the call reports its budget exhausted instead of overrunning it");
  assert.deepEqual(blockRow(store, "aaa"), aaaParked,
    "aaa's block is byte-identical: its re-diagnosis did not complete inside the deadline and was deferred, not half-recorded");
  assert.deepEqual(blockRow(store, "bbb"), bbbParked,
    "bbb's block is byte-identical: the deadline stopped the refresh before a second full replay could start");

  const generous = store.backfillMessages({ limit: 1000, deadline: Date.now() + 60000 });
  assert.equal(generous.budgetExceeded, false);
  assert.equal(blockRow(store, "aaa").head_seq, newHead("aaa"),
    "the deferred re-diagnosis runs on a later call: aaa's block is refreshed to its new head");
  assert.equal(blockRow(store, "bbb").head_seq, newHead("bbb"),
    "the deferred re-diagnosis runs on a later call: bbb's block is refreshed to its new head");
  assert.equal(blockRow(store, "aaa").event_id, "ev-poison-aaa", "still parked on the same poison");
  assert.equal(blockRow(store, "bbb").event_id, "ev-poison-bbb", "still parked on the same poison");
});

test("F4: a deferred re-diagnosis still clears a repaired room on a later call", t => {
  const store = open(t);
  bigPoisonedRoom(store, "ccc");
  store.backfillMessages({ limit: 1000 });
  assert.ok(blockRow(store, "ccc"), "the room parks in the seeding call");

  repairInPlace(store, "ccc", "ev-poison-ccc", "bad id@x", "repaired");
  tearSnapshot(store, "ccc");
  moveHead(store, "ccc", "c");
  const parkedRow = blockRow(store, "ccc");

  const starved = store.backfillMessages({ limit: 1000, deadline: Date.now() + 30 });
  assert.equal(starved.budgetExceeded, true);
  assert.deepEqual(blockRow(store, "ccc"), parkedRow,
    "the repaired room stays parked while its re-diagnosis is over the deadline: deferral, not a silent clear or a half-update");

  const generous = store.backfillMessages({ limit: 1000, deadline: Date.now() + 60000 });
  assert.deepEqual(generous.blocked, [], "with budget available the re-diagnosis clears the repaired room");
  assert.equal(blockRow(store, "ccc"), null);
  assert.ok(rows(store, "ccc").some(row => row.message_id === "repaired"),
    "the room rejoins the sweep and its rows backfill in the same call");
  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  assert.equal(parity.roomId, "ccc");
});

test("F5: two rooms parking in one call are both surfaced as durable named failures", t => {
  const store = open(t);
  for (const roomId of ["ddd", "eee"]) {
    store.initialize([
      ...initialRoom(roomId),
      messageEvent(roomId, `ev-standin-${roomId}`, T.MESSAGE_POSTED, { messageId: "standin", body: "legacy text" }, 10),
      messageEvent(roomId, `ev-tail-${roomId}`, T.MESSAGE_POSTED, { messageId: "tail", body: "after the poison" }, 11)
    ]);
    poisonEvent(store, roomId, `ev-standin-${roomId}`, "standin", "bad id@x");
  }

  const result = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(result.blocked.map(block => [block.roomId, block.fresh]), [["ddd", true], ["eee", true]],
    "both rooms park in one call and both are marked fresh in that call's result");
  assert.deepEqual(result.failed.map(failure => failure.roomId), ["ddd", "eee"],
    "both rooms are this call's fresh failures");

  store.runIntegrityBackfillStep(Date.now() + 60000);
  const recorded = store.db.prepare(
    "SELECT record_id AS recordId FROM integrity_failures WHERE step='messages_backfill' ORDER BY record_id"
  ).all().map(row => row.recordId);
  assert.deepEqual(recorded, ["ddd", "eee"],
    "the deferred step records BOTH rooms as durable named failures — the second room's one-time surface is not lost");
});

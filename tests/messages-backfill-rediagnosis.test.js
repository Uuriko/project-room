import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event, replay } from "../src/events.js";
import * as messagesStore from "../server/messages-store.mjs";

// Namespace read so the behavioral pins below still run (and fail on
// their assertions) against a tree without the cadence export.
const MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS = messagesStore.MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS;

// Issue #3878: a parked room was only re-diagnosed when its head moved, so
// the natural operator repair — fixing the named event in place — never
// cleared the park on a quiet room, and neither did a deploy that fixed
// the reducer. refreshStaleBlocks now re-diagnoses head-unmoved parks on
// a slow cadence (stamped per room, one periodic attempt per call): a
// repaired room clears and rejoins the sweep in the same call, a
// still-poisoned room costs one replay per interval instead of one per
// tick, and a changed diagnosis advances the standing accusation to the
// next poison. Time is driven by writing the stamp column directly, the
// same way the fixtures write the block rows themselves.

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-messages-backfill-rediagnosis-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
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

// The operator repair from the findings' repro B: fix the stored event and
// its projection entry in place. No event is appended; the head does not
// move.
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

// Make a parked room due for its periodic re-diagnosis: a stamp far past
// the interval, in the shape a long-parked room's row would carry.
function ageOut(store, roomId) {
  store.db.prepare("UPDATE messages_backfill_blocks SET last_diagnosed_at=1 WHERE room_id=?").run(roomId);
}

function poisonedRoom(store, roomId, tag = "") {
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, `ev-standin${tag}`, T.MESSAGE_POSTED, { messageId: "standin", body: "legacy text" }, 10),
    messageEvent(roomId, `ev-tail${tag}`, T.MESSAGE_POSTED, { messageId: "tail", body: "after the poison" }, 11)
  ]);
  return poisonEvent(store, roomId, `ev-standin${tag}`, "standin", "bad id@x");
}

test("an in-place repair clears the park on the cadence, with no head movement", t => {
  const store = open(t);
  const poisonSeq = poisonedRoom(store, "aaa");
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa'").get().sequence;

  const first = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(first.blocked, [{
    roomId: "aaa", sequence: poisonSeq, eventId: "ev-standin", error: "Invalid messageId", fresh: true
  }]);

  repairInPlace(store, "aaa", "ev-standin", "bad id@x", "repaired");
  const tooSoon = store.backfillMessages({ limit: 1000 });
  assert.equal(tooSoon.blocked.length, 1, "the repair alone does not clear the park; the cadence gates the re-diagnosis");
  assert.equal(tooSoon.blocked[0].fresh, false);
  assert.equal(rows(store, "aaa").length, 0);

  ageOut(store, "aaa");
  const cleared = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(cleared.blocked, [], "the due re-diagnosis replays the repaired log cleanly and clears the park");
  assert.deepEqual(rows(store, "aaa").map(row => row.message_id), ["repaired", "tail"],
    "the room rejoins the sweep and backfills in the same call");
  assert.equal(store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa'").get().sequence, head,
    "the head never moved: no event was appended at any point");
  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  assert.equal(parity.roomId, "aaa");
});

test("a still-poisoned room is re-diagnosed at most once per interval", t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  store.backfillMessages({ limit: 1000 });
  const parked = blockRow(store, "aaa");
  assert.ok(parked.last_diagnosed_at > 0, "the park itself stamps the cadence clock");
  assert.equal(parked.last_diagnosed_at, parked.blocked_at, "one diagnosis, one stamp");

  ageOut(store, "aaa");
  const result = store.backfillMessages({ limit: 1000 });
  assert.equal(result.blocked[0].fresh, false, "an unchanged diagnosis is not re-surfaced as fresh");
  const rediagnosed = blockRow(store, "aaa");
  assert.ok(rediagnosed.last_diagnosed_at > 1, "the periodic attempt is recorded");
  for (const field of ["sequence", "event_id", "error", "head_seq", "blocked_at"]) {
    assert.equal(rediagnosed[field], parked[field], `the standing accusation is untouched: ${field}`);
  }
  assert.equal(rows(store, "aaa").length, 0);

  store.backfillMessages({ limit: 1000 });
  assert.deepEqual(blockRow(store, "aaa"), rediagnosed,
    "inside the interval the room is not re-diagnosed again: the row is byte-identical");
});

test("the per-call budget re-diagnoses one due room per call", t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  poisonedRoom(store, "bbb", "-b");
  store.backfillMessages({ limit: 1000 });
  ageOut(store, "aaa");
  ageOut(store, "bbb");

  store.backfillMessages({ limit: 1000 });
  const aaaAfter = blockRow(store, "aaa");
  assert.ok(aaaAfter.last_diagnosed_at > 1, "the first due room (room_id order) was re-diagnosed");
  assert.equal(blockRow(store, "bbb").last_diagnosed_at, 1,
    "the budget leaves the second due room for a later call");

  store.backfillMessages({ limit: 1000 });
  assert.ok(blockRow(store, "bbb").last_diagnosed_at > 1, "the next call takes the remaining due room");
  assert.equal(blockRow(store, "aaa").last_diagnosed_at, aaaAfter.last_diagnosed_at,
    "the first room is inside its interval now and is not re-diagnosed");
});

test("re-diagnosis advances the standing accusation to the next poison", t => {
  const store = open(t);
  store.initialize([
    ...initialRoom("multi"),
    messageEvent("multi", "ev-p1", T.MESSAGE_POSTED, { messageId: "first", body: "one" }, 10),
    messageEvent("multi", "ev-p2", T.MESSAGE_POSTED, { messageId: "second", body: "two" }, 11),
    messageEvent("multi", "ev-tail", T.MESSAGE_POSTED, { messageId: "tail", body: "three" }, 12)
  ]);
  poisonEvent(store, "multi", "ev-p1", "first", "bad id@x");
  poisonEvent(store, "multi", "ev-p2", "second", "bad id@y");
  const bodies = store.db.prepare("SELECT body FROM events WHERE room_id='multi' ORDER BY sequence").all()
    .map(row => JSON.parse(row.body));
  assert.throws(() => replay(bodies), /Invalid messageId/, "fixture guard: the seeded log rejects raw replay");

  const first = store.backfillMessages({ limit: 1000 });
  assert.equal(first.blocked[0].eventId, "ev-p1", "the park names the first poison");

  repairInPlace(store, "multi", "ev-p1", "bad id@x", "repaired-first");
  ageOut(store, "multi");
  const advanced = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(advanced.blocked, [{
    roomId: "multi", sequence: blockRow(store, "multi").sequence, eventId: "ev-p2", error: "Invalid messageId", fresh: true
  }], "with the first poison repaired in place, re-diagnosis discovers and names the second");
  assert.equal(rows(store, "multi").length, 0, "still parked: nothing partial is written");

  repairInPlace(store, "multi", "ev-p2", "bad id@y", "repaired-second");
  ageOut(store, "multi");
  const cleared = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(cleared.blocked, []);
  assert.deepEqual(rows(store, "multi").map(row => row.message_id), ["repaired-first", "repaired-second", "tail"]);
  const parity = store.checkMessagesParity();
  assert.equal(parity.ok, true);
  assert.equal(parity.roomId, "multi");
});

test("a room parked during a call is stamped once, at the park, and surfaced once", t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  // refreshStaleBlocks runs before the fill loop and the loop never
  // re-enters it, so a room the loop parks cannot be re-diagnosed until a
  // later call; the observable pin is that its stamp is exactly the park's
  // own stamp and the next call leaves the row untouched.
  const first = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(first.failed.map(failure => failure.roomId), ["aaa"], "the fresh failure is reported exactly once");
  const parked = blockRow(store, "aaa");
  assert.equal(parked.last_diagnosed_at, parked.blocked_at, "stamped once, by the park itself");
  const second = store.backfillMessages({ limit: 1000 });
  assert.equal(second.failed.length, 0);
  assert.equal(second.blocked[0].fresh, false);
  assert.deepEqual(blockRow(store, "aaa"), parked, "the next call does not re-diagnose the just-parked room");
});

test("an unstamped block row starts its cadence clock instead of being diagnosed on sight", t => {
  const store = open(t);
  store.initialize([
    ...initialRoom("clean"),
    messageEvent("clean", "ev-c1", T.MESSAGE_POSTED, { messageId: "c1", body: "fine" }, 10)
  ]);
  store.backfillMessages({ limit: 1000 });
  assert.equal(rows(store, "clean").length, 1);
  // A row written before the cadence column existed (or inserted directly,
  // as the health-surface fixtures do) carries last_diagnosed_at = 0.
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id='clean'").get().sequence;
  store.db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at)
    VALUES (?, ?, ?, ?, ?, ?)`).run("clean", head, "ev-c1", "legacy block", head, Date.now());

  store.backfillMessages({ limit: 1000 });
  const stamped = blockRow(store, "clean");
  assert.ok(stamped, "the row is not diagnosed (and so not cleared) on first sight");
  assert.ok(stamped.last_diagnosed_at > 0, "its cadence clock starts instead");
  assert.equal(stamped.error, "legacy block");

  ageOut(store, "clean");
  const cleared = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(cleared.blocked, [], "once due, the same re-diagnosis clears a block whose log replays cleanly");
});

test("the deferred backfill step's failure record clears after a cadence repair", t => {
  const store = open(t);
  poisonedRoom(store, "aaa");
  store.runIntegrityBackfillStep(Date.now() + 5000);
  assert.deepEqual(
    store.integrityFailures().filter(row => row.step === "messages_backfill").map(row => row.recordId),
    ["aaa"], "the standing block is recorded as a durable named failure");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 1,
    "the parked count the health contract reads is 1 while parked");

  repairInPlace(store, "aaa", "ev-standin", "bad id@x", "repaired");
  ageOut(store, "aaa");
  store.runIntegrityBackfillStep(Date.now() + 5000);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 0,
    "the parked count reads 0 once the cadence clears the park");
  assert.deepEqual(
    store.integrityFailures().filter(row => row.step === "messages_backfill"),
    [], "the failure record clears with the park: health stops naming the repaired room");
  assert.deepEqual(rows(store, "aaa").map(row => row.message_id), ["repaired", "tail"]);
});

test("the cadence interval is a bounded, nonzero constant", () => {
  assert.ok(Number.isFinite(MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS));
  assert.ok(MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS >= 60 * 60 * 1000, "at least an hour: a poisoned room's replay is not cheap");
  assert.ok(MESSAGES_BLOCK_REDIAGNOSIS_INTERVAL_MS <= 24 * 60 * 60 * 1000, "at most a day: a repaired room clears the same day");
});

// Issue #3904 (residual): the periodic path honored the caller's deadline
// but head-moved re-diagnoses ran unconditionally — one tick with many
// head-moved parks could replay every one of them past its budget. The
// head-moved branch now checks the same deadline before each diagnosis
// and defers the rest: a deferred room's head still differs from its
// recorded head on the next call, so nothing is lost by deferring.

// Append events directly to the stored log and move the room's head, the
// way live writes the backfill has not replayed yet would land.
function appendRaw(store, roomId, events) {
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  const insert = store.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
  events.forEach((entry, index) => insert.run(roomId, head + index + 1, entry.id, JSON.stringify(entry)));
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(head + events.length, roomId);
  return head + 1;
}

// A parked room whose re-diagnosis is a full-log replay: a long clean log
// with the poison at the end, parked, with the resume cursor dropped so
// diagnoseFromCursor has no snapshot and the fallback replay runs. One
// such replay costs far more than the test deadline below, which is what
// makes the deadline observable deterministically.
function longParkedRoom(store, roomId, bulkCount) {
  store.initialize([
    ...initialRoom(roomId),
    messageEvent(roomId, `ev-seed-${roomId}`, T.MESSAGE_POSTED, { messageId: "seed", body: "seed" }, 10)
  ]);
  store.backfillMessages({ limit: 1000 });
  appendRaw(store, roomId, Array.from({ length: bulkCount }, (_, index) =>
    messageEvent(roomId, `ev-bulk-${roomId}-${index}`, T.MESSAGE_POSTED, { messageId: `bulk-${index}`, body: `bulk ${index}` }, 20 + index)));
  const poisonSeq = appendRaw(store, roomId, [
    messageEvent(roomId, `ev-poison-${roomId}`, T.MESSAGE_POSTED, { messageId: "poison", body: "poison" }, 20 + bulkCount),
    messageEvent(roomId, `ev-tail-${roomId}`, T.MESSAGE_POSTED, { messageId: "tail", body: "tail" }, 21 + bulkCount)
  ]);
  const poisonRow = store.db.prepare("SELECT body FROM events WHERE id=?").get(`ev-poison-${roomId}`);
  const poisonBody = JSON.parse(poisonRow.body);
  poisonBody.data.messageId = "bad id@x";
  store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(poisonBody), `ev-poison-${roomId}`);
  const parked = store.backfillMessages({ limit: 1000 });
  assert.equal(parked.blocked.find(block => block.roomId === roomId)?.sequence, poisonSeq,
    "fixture guard: the long room parks at its poison");
  store.db.prepare("DELETE FROM messages_backfill_cursor WHERE room_id=?").run(roomId);
  return poisonSeq;
}

test("head-moved re-diagnoses honor the caller's deadline and defer the rest", t => {
  const store = open(t);
  longParkedRoom(store, "aaa", 900);
  poisonedRoom(store, "bbb", "-b");
  store.backfillMessages({ limit: 1000 });
  assert.ok(blockRow(store, "bbb"), "fixture guard: the small room is parked too");

  // Move both heads: each room earns a head-moved re-diagnosis.
  appendRaw(store, "aaa", [messageEvent("aaa", "ev-extra-a", T.MESSAGE_POSTED, { messageId: "extra-a", body: "extra" }, 5000)]);
  appendRaw(store, "bbb", [messageEvent("bbb", "ev-extra-b", T.MESSAGE_POSTED, { messageId: "extra-b", body: "extra" }, 5000)]);
  const aaaParked = blockRow(store, "aaa");
  const bbbParked = blockRow(store, "bbb");
  const aaaHead = store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa'").get().sequence;
  const bbbHead = store.db.prepare("SELECT sequence FROM rooms WHERE id='bbb'").get().sequence;
  assert.ok(aaaHead > aaaParked.head_seq && bbbHead > bbbParked.head_seq,
    "fixture guard: both heads moved past their recorded heads");

  // aaa's full replay outlasts the deadline on its own, so bbb's
  // head-moved diagnosis must not start in this call at all.
  store.backfillMessages({ limit: 1000, deadline: Date.now() + 15 });
  assert.equal(blockRow(store, "aaa").head_seq, aaaHead,
    "the first head-moved room was re-diagnosed: its block records the moved head");
  assert.deepEqual(blockRow(store, "bbb"), bbbParked,
    "the second head-moved room is deferred untouched once the deadline passes");

  // The deferral loses nothing: the next call with time to spare takes
  // the deferred room, whose head still differs from its recorded head.
  store.backfillMessages({ limit: 1000 });
  assert.equal(blockRow(store, "bbb").head_seq, bbbHead,
    "the deferred room is re-diagnosed by the next call");
  assert.deepEqual(
    store.db.prepare("SELECT room_id FROM messages_backfill_blocks ORDER BY room_id").all().map(row => row.room_id),
    ["aaa", "bbb"], "both rooms stay parked: their logs are still poisoned");
});

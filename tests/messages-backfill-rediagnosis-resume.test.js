import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { EVENT_TYPES as T, event } from "../src/events.js";

// r52: a parked room's re-diagnosis replayed the whole log from sequence 0
// with no deadline. On muse-room's own log (about 14k events) that was 35.8 s
// of CPU in one integrity tick on a 4-CPU box, over the production Durable
// Object's 30 s cpu_ms. The cursor already holds the state the backfill
// resumes from, so the re-diagnosis now starts there and only asks whether
// the room moves past its block. And a room whose park was lifted is lagging,
// not failing: its integrity record clears then, not after full catch-up
// (hourly-only, muse-room had not caught up after 152 simulated hours).

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "r52-rediagnosis-resume-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return store;
}

const at = offset => new Date(Date.UTC(2026, 9, 2) + offset * 1000).toISOString();
const posted = (roomId, id, messageId, offset) => event({
  type: T.MESSAGE_POSTED, actorId: "owner", roomId, id, idempotencyKey: `${id}-key`, at: at(offset), data: { messageId, body: `text ${messageId}` }
});

function append(store, roomId, events) {
  // Stand-in for live writes: the stored log and projection gain events the
  // backfill has not replayed yet.
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  const insert = store.db.prepare("INSERT INTO events VALUES(?,?,?,?)");
  events.forEach((e, i) => insert.run(roomId, head + i + 1, e.id, JSON.stringify(e)));
  store.db.prepare("UPDATE rooms SET sequence=? WHERE id=?").run(head + events.length, roomId);
  return head + 1;
}

function setMessageId(store, eventId, messageId) {
  const row = store.db.prepare("SELECT body FROM events WHERE id=?").get(eventId);
  const body = JSON.parse(row.body);
  body.data.messageId = messageId;
  store.db.prepare("UPDATE events SET body=? WHERE id=?").run(JSON.stringify(body), eventId);
}

// Genesis + two posts, fully backfilled (cursor snapshot at the head), then a
// poisoned live event and a tail: the backfill parks at the poison.
function parkedRoom(store, roomId, tail = 1) {
  store.initialize([...initialRoom(roomId), posted(roomId, "ev-a", "a", 10), posted(roomId, "ev-b", "b", 11)]);
  assert.equal(store.backfillMessages({ limit: 1000 }).done, true);
  const poisonSeq = append(store, roomId, [posted(roomId, "ev-p", "p", 12),
    ...Array.from({ length: tail }, (_, i) => posted(roomId, `ev-t${i}`, `t${i}`, 13 + i))]);
  setMessageId(store, "ev-p", "bad id@x");
  const parked = store.backfillMessages({ limit: 1000 });
  assert.equal(parked.blocked.length, 1);
  assert.equal(parked.blocked[0].sequence, poisonSeq);
  return poisonSeq;
}

test("a head-moved re-diagnosis resumes from the cursor snapshot, not sequence 0", t => {
  const store = open(t);
  parkedRoom(store, "aaa");
  // An event the backfill already applied (before its cursor) no longer
  // replays. A from-zero replay would move the park back to it; the backfill
  // itself never re-reads it, so the resume diagnosis does not either.
  setMessageId(store, "ev-a", "also bad@x");
  setMessageId(store, "ev-p", "p"); // operator repair of the named event
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]); // head moves
  const after = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(after.blocked, [], "the room moves past its block, so the park lifts");
  const { lag } = store.db.prepare("SELECT r.sequence - c.applied_seq AS lag FROM rooms r JOIN messages_backfill_cursor c ON c.room_id=r.id WHERE r.id='aaa'").get();
  assert.equal(lag, 0, "and the backfill replays to the head in the same call");
});

test("a re-diagnosis still keeps the park when the named event still fails", t => {
  const store = open(t);
  const poisonSeq = parkedRoom(store, "aaa");
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]);
  const after = store.backfillMessages({ limit: 1000 });
  assert.equal(after.blocked.length, 1);
  assert.equal(after.blocked[0].sequence, poisonSeq);
});

test("without a usable snapshot the re-diagnosis falls back to the full replay", t => {
  const store = open(t);
  parkedRoom(store, "aaa");
  setMessageId(store, "ev-a", "also bad@x");
  setMessageId(store, "ev-p", "p");
  store.db.prepare("UPDATE messages_backfill_cursor SET state_seq=0 WHERE room_id='aaa'").run();
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]);
  const after = store.backfillMessages({ limit: 1000 });
  assert.equal(after.blocked.length, 1, "the full replay finds the earlier event");
  assert.equal(after.blocked[0].eventId, "ev-a");
});

test("a lifted park clears the room's integrity record before the room catches up", t => {
  const store = open(t);
  // A tail longer than one MESSAGES_BACKFILL_BATCH (200) keeps the room
  // lagging after the lift on main as well as with Unmeb's per-call limit.
  parkedRoom(store, "aaa", 450);
  store.runIntegrityBackfillStep(Date.now() + 5000);
  assert.ok(store.integrityFailures().some(row => row.step === "messages_backfill" && row.recordId === "aaa"), "parked: recorded");
  setMessageId(store, "ev-p", "p");
  append(store, "aaa", [posted("aaa", "ev-n", "n", 300)]);
  store.runIntegrityBackfillStep(Date.now() + 5000, { limit: 25 });
  const lag = store.db.prepare(`SELECT r.sequence - c.applied_seq AS lag FROM rooms r JOIN messages_backfill_cursor c ON c.room_id=r.id WHERE r.id='aaa'`).get().lag;
  assert.ok(lag > 0, `still catching up (lag ${lag})`);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 0);
  assert.deepEqual(store.integrityFailures().filter(row => row.step === "messages_backfill"), [], "lag is not a failure");
});

// Schema42 separates replay progress from certified message-row progress.
test("re-diagnosis resumes from a snapshot ahead of certification", t => {
  const store = open(t);
  parkedRoom(store, "aaa");
  store.db.prepare("UPDATE messages_backfill_cursor SET applied_seq=0, applied_event_id='' WHERE room_id='aaa'").run();
  setMessageId(store, "ev-a", "also bad@x");
  setMessageId(store, "ev-p", "p");
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]);
  const after = store.backfillMessages({limit:1000});
  assert.deepEqual(after.blocked, []);
  assert.equal(after.done, true);
});

// r66: muse-room's cursor snapshot is far over STATE_PART_CHARS (600,000), so
// saveCursor stores it in messages_backfill_state parts and state_json holds
// only "parts:<n>:<sha>". diagnoseFromCursor parsed state_json directly, which
// throws on that marker, so for exactly the room r52 was written for the
// re-diagnosis always fell back to the full replay from sequence 0.
test("a re-diagnosis resumes from a parts-split cursor snapshot too", t => {
  const store = open(t);
  const big = (id, messageId, offset) => event({
    type: T.MESSAGE_POSTED, actorId: "owner", roomId: "aaa", id, idempotencyKey: `${id}-key`, at: at(offset),
    data: { messageId, body: `${messageId} ${"x".repeat(60000)}` }
  });
  store.initialize([...initialRoom("aaa"), ...Array.from({ length: 12 }, (_, i) => big(`ev-big${i}`, `big${i}`, i + 1))]);
  assert.equal(store.backfillMessages({ limit: 1000 }).done, true);
  const poisonSeq = append(store, "aaa", [posted("aaa", "ev-p", "p", 40), posted("aaa", "ev-t", "t", 41)]);
  setMessageId(store, "ev-p", "bad id@x");
  const parked = store.backfillMessages({ limit: 1000 });
  assert.equal(parked.blocked[0]?.sequence, poisonSeq);
  const { state_json: marker } = store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='aaa'").get();
  assert.match(marker, /^parts:\d+:[0-9a-f]{64}$/, "the snapshot is stored in parts");
  // Same shape as the first test: an applied event no longer replays, the
  // named event is repaired, the head moves. Only a from-zero replay sees ev-big0.
  setMessageId(store, "ev-big0", "also bad@x");
  setMessageId(store, "ev-p", "p");
  append(store, "aaa", [posted("aaa", "ev-n", "n", 50)]);
  const after = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(after.blocked, [], "the resume diagnosis read the parts snapshot and lifted the park");
});

test("an unchanged re-diagnosis keeps blocked_at and moves only the diagnosis clock", t => {
  const store = open(t);
  const poisonSeq = parkedRoom(store, "aaa");
  store.db.prepare("UPDATE messages_backfill_blocks SET blocked_at=1, last_diagnosed_at=1 WHERE room_id='aaa'").run();
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]);
  const after = store.backfillMessages({ limit: 1000 });
  assert.equal(after.blocked[0]?.sequence, poisonSeq);
  assert.equal(after.blocked[0].fresh, false);
  const row = store.db.prepare("SELECT blocked_at, last_diagnosed_at, head_seq FROM messages_backfill_blocks WHERE room_id='aaa'").get();
  assert.equal(row.blocked_at, 1, "the accusation's time is kept");
  assert.ok(row.last_diagnosed_at > 1, "the diagnosis clock moved");
  assert.equal(row.head_seq, store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa'").get().sequence);
});

test("a fresh park names the event after the cursor, not an older applied one", t => {
  const store = open(t);
  store.initialize([...initialRoom("aaa"), posted("aaa", "ev-a", "a", 10), posted("aaa", "ev-b", "b", 11)]);
  assert.equal(store.backfillMessages({ limit: 1000 }).done, true);
  // ev-a was applied under an earlier reducer and no longer replays; the
  // backfill resumes after it and fails at the new poisoned event.
  setMessageId(store, "ev-a", "also bad@x");
  const poisonSeq = append(store, "aaa", [posted("aaa", "ev-p", "p", 12), posted("aaa", "ev-t", "t", 13)]);
  setMessageId(store, "ev-p", "bad id@x");
  const parked = store.backfillMessages({ limit: 1000 });
  assert.equal(parked.blocked.length, 1);
  assert.equal(parked.blocked[0].sequence, poisonSeq);
  assert.equal(parked.blocked[0].eventId, "ev-p");
});

// r71: parks recorded before diagnoseFreshBlock can name an event the
// backfill already applied (below the cursor snapshot). The re-diagnosis
// must not keep such a park forever by replaying from sequence 0.
function standingParkBelowCursor(store, roomId) {
  store.initialize([...initialRoom(roomId), posted(roomId, "ev-a", "a", 10), posted(roomId, "ev-b", "b", 11)]);
  assert.equal(store.backfillMessages({ limit: 1000 }).done, true);
  setMessageId(store, "ev-a", "also bad@x");
  const seqA = store.db.prepare("SELECT sequence FROM events WHERE id='ev-a'").get().sequence;
  const { state_seq: stateSeq } = store.db.prepare("SELECT state_seq FROM messages_backfill_cursor WHERE room_id=?").get(roomId);
  assert.ok(seqA <= stateSeq, "the named event is at or below the cursor snapshot");
  const head = store.db.prepare("SELECT sequence FROM rooms WHERE id=?").get(roomId).sequence;
  store.db.prepare(`INSERT INTO messages_backfill_blocks (room_id, sequence, event_id, error, head_seq, blocked_at, last_diagnosed_at)
    VALUES (?, ?, 'ev-a', 'parked by a from-zero diagnosis', ?, 1, 1)`).run(roomId, seqA, head);
  return seqA;
}

test("a standing park on an already-applied event lifts when the head moves", t => {
  const store = open(t);
  standingParkBelowCursor(store, "aaa");
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]);
  const after = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(after.blocked, [], "the backfill never re-reads the named event, so the park lifts");
  const { lag } = store.db.prepare("SELECT r.sequence - c.applied_seq AS lag FROM rooms r JOIN messages_backfill_cursor c ON c.room_id=r.id WHERE r.id='aaa'").get();
  assert.equal(lag, 0, "and the backfill replays to the head in the same call");
});

test("a standing park on an already-applied event lifts on the periodic cadence too", t => {
  const store = open(t);
  standingParkBelowCursor(store, "aaa");
  append(store, "aaa", [posted("aaa", "ev-n", "n", 30)]);
  // head_seq already at the new head: only the six-hour cadence re-diagnoses
  store.db.prepare("UPDATE messages_backfill_blocks SET head_seq=(SELECT sequence FROM rooms WHERE id='aaa'), last_diagnosed_at=1 WHERE room_id='aaa'").run();
  const after = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(after.blocked, []);
});

test("a standing park below the cursor moves to the real failure after it", t => {
  const store = open(t);
  standingParkBelowCursor(store, "aaa");
  const poisonSeq = append(store, "aaa", [posted("aaa", "ev-p", "p", 40), posted("aaa", "ev-t", "t", 41)]);
  setMessageId(store, "ev-p", "bad id@x");
  const after = store.backfillMessages({ limit: 1000 });
  assert.equal(after.blocked.length, 1);
  assert.equal(after.blocked[0].sequence, poisonSeq, "the park names the event the backfill actually stops at");
  assert.equal(after.blocked[0].eventId, "ev-p");
});

// Quiet rooms must recover on the periodic pass without a new chat message.
test("a standing park at the current head lifts without a new event", t => {
  const store = open(t);
  standingParkBelowCursor(store, "aaa");
  const before = store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa'").get().sequence;
  const after = store.backfillMessages({ limit: 1000 });
  assert.deepEqual(after.blocked, []);
  assert.equal(after.done, true);
  assert.equal(store.db.prepare("SELECT sequence FROM rooms WHERE id='aaa'").get().sequence, before);
});

for (const corruption of ["anchor", "snapshot"]) {
  test(`a quiet-head park stays blocked with a corrupt ${corruption}`, t => {
    const store = open(t);
    standingParkBelowCursor(store, "aaa");
    if (corruption === "anchor") store.db.prepare("UPDATE messages_backfill_cursor SET applied_event_id='stale-anchor' WHERE room_id='aaa'").run();
    else store.db.prepare("UPDATE message_replay_snapshots SET state_json='not-json' WHERE room_id='aaa'").run();
    const after = store.backfillMessages({ limit: 1000 });
    assert.equal(after.blocked.length, 1);
    assert.equal(after.blocked[0].eventId, "ev-a", "untrusted cursor falls back to replay and retains the real refusal");
  });
}

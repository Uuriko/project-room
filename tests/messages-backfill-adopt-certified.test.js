import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { JOBS } from "../server/jobs.mjs";
import { EVENT_TYPES as T } from "../src/events.js";

// Prod integrity has reported messages_backfill_failed since 2026-10-11:
// a message delete discarded the replay snapshot, the next fill replayed
// from sequence 0, and a legacy event the current reducer rejects — one
// the backfill had already certified — parked the room. Re-diagnosis found
// that same event again. Adopting the live projection clears that park.
// A rejection after the certified cursor is a real poison. The current
// backfill quarantines that event (skipped=1) instead of parking the room,
// and adopt must not clear it or move the cursor.

const integrityJob = JOBS.find(job => job.name === "integrity");

function open(t) {
  const directory = mkdtempSync(join(tmpdir(), "backfill-adopt-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey("commons", "owner");
  const cmd = (type, data) => store.command(ownerKey, "commons", { id: randomUUID(), type, data });
  return { store, cmd };
}

function backfillAll(store) {
  let result;
  for (let i = 0; i < 20; i += 1) {
    result = store.backfillMessages({ limit: 400 });
    if (result.done) break;
  }
  return result;
}

function ageIntoLegacyShape(store, messageId) {
  const row = store.db.prepare("SELECT sequence, id, body FROM events WHERE room_id='commons' AND body LIKE ?").get(`%"messageId":"${messageId}"%`);
  const stored = JSON.parse(row.body);
  stored.data.body = "legacy ".repeat(10_000);
  store.db.prepare("UPDATE events SET body=? WHERE room_id='commons' AND sequence=?").run(JSON.stringify(stored), row.sequence);
  return { sequence: row.sequence, eventId: row.id };
}

function discardSnapshot(store) {
  store.db.prepare("DELETE FROM message_replay_snapshots WHERE room_id='commons'").run();
  store.db.prepare("DELETE FROM messages_backfill_state WHERE room_id='commons'").run();
  store.db.prepare("UPDATE messages_backfill_cursor SET state_seq=0, replay_event_id='' WHERE room_id='commons'").run();
}

function cursorOf(store) {
  return store.db.prepare("SELECT applied_seq, applied_event_id, state_seq FROM messages_backfill_cursor WHERE room_id='commons'").get();
}

function headOf(store) {
  const sequence = store.db.prepare("SELECT sequence FROM rooms WHERE id='commons'").get().sequence;
  const id = store.db.prepare("SELECT id FROM events WHERE room_id='commons' AND sequence=?").get(sequence).id;
  return { sequence, id };
}

async function integrityTick(store) {
  let last;
  for (let i = 0; i < 6; i += 1) last = await integrityJob.run(store, { deadline: Date.now() + 60_000 });
  return last;
}

test("a discarded snapshot does not park an event the backfill already certified", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "old", body: "written before the tightening" });
  cmd(T.MESSAGE_POSTED, { messageId: "keep", body: "keep me" });
  assert.equal(backfillAll(store).done, true);
  const aged = ageIntoLegacyShape(store, "old");
  discardSnapshot(store);
  cmd(T.MESSAGE_POSTED, { messageId: "later", body: "after the snapshot was discarded" });
  assert.ok(cursorOf(store).applied_seq < headOf(store).sequence);

  const result = store.backfillMessages({ limit: 400 });
  assert.deepEqual(result.blocked, []);
  assert.deepEqual(result.failed, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 0);
  const head = headOf(store);
  const cursor = cursorOf(store);
  assert.equal(cursor.applied_seq, head.sequence);
  assert.equal(cursor.applied_event_id, head.id);
  assert.equal(cursor.state_seq, head.sequence);
  assert.equal(typeof store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get()?.state_json, "string");
  assert.equal(store.db.prepare("SELECT body FROM messages WHERE room_id='commons' AND message_id='later'").get().body, "after the snapshot was discarded");
  assert.ok(aged.sequence <= cursor.applied_seq);

  const tick = await integrityTick(store);
  assert.equal(tick.scanError, undefined, JSON.stringify(tick));
  assert.equal(store.integrityFailures().some(row => row.step === "messages_backfill"), false);
});

test("a standing park on an already-certified event clears on the next backfill", t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "old", body: "written before the tightening" });
  cmd(T.MESSAGE_POSTED, { messageId: "keep", body: "keep me" });
  assert.equal(backfillAll(store).done, true);
  const aged = ageIntoLegacyShape(store, "old");
  discardSnapshot(store);
  const head = headOf(store);
  const diagnosedAt = Date.now();
  store.db.prepare(`INSERT INTO messages_backfill_blocks
    (room_id, sequence, event_id, error, head_seq, blocked_at, last_diagnosed_at)
    VALUES ('commons', ?, ?, 'legacy event', ?, ?, ?)`).run(aged.sequence, aged.eventId, head.sequence, diagnosedAt, diagnosedAt);

  const result = store.backfillMessages({ limit: 400 });
  assert.deepEqual(result.blocked, []);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS n FROM messages_backfill_blocks").get().n, 0);
  const cursor = cursorOf(store);
  assert.equal(cursor.applied_seq, head.sequence);
  assert.equal(cursor.applied_event_id, head.id);
  assert.equal(typeof store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get()?.state_json, "string");
});

test("a reducer rejection after the certified cursor is quarantined and not adopted", async t => {
  const { store, cmd } = open(t);
  cmd(T.MESSAGE_POSTED, { messageId: "old", body: "already certified" });
  assert.equal(backfillAll(store).done, true);
  const certified = cursorOf(store).applied_seq;
  cmd(T.MESSAGE_POSTED, { messageId: "later", body: "not certified yet" });
  const aged = ageIntoLegacyShape(store, "later");
  assert.ok(aged.sequence > certified);
  assert.equal(typeof store.db.prepare("SELECT state_json FROM message_replay_snapshots WHERE room_id='commons'").get()?.state_json, "string");

  const result = store.backfillMessages({ limit: 400 });
  const held = [...result.blocked, ...result.quarantined];
  assert.equal(held.length, 1);
  assert.equal(held[0].sequence, aged.sequence);
  assert.equal(result.blocked.length, 0, "a reducer rejection is quarantined, not a room park");
  const second = store.backfillMessages({ limit: 400 });
  const still = [...second.blocked, ...second.quarantined];
  assert.equal(still.length, 1);
  assert.equal(still[0].sequence, aged.sequence);
  assert.equal(store.room("commons").state.messages.find(message => message.id === "later").body, "not certified yet");

  const tick = await integrityTick(store);
  assert.equal(tick.scanError, undefined, JSON.stringify(tick));
  assert.equal(tick.blockedRooms, 0);
  assert.equal(tick.quarantinedEvents, 1);
  const row = store.db.prepare("SELECT sequence, event_id, skipped FROM messages_backfill_blocks WHERE room_id='commons'").get();
  assert.equal(row.skipped, 1);
  assert.equal(row.sequence, aged.sequence);
  assert.equal(row.event_id, aged.eventId);
  assert.ok(cursorOf(store).applied_seq >= certified);
});

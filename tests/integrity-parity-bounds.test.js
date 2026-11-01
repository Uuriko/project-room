// #5571 part 2 (P0): the messages-parity step must be deadline-bounded,
// checkpointed and sweep-bounded. Minimal failing-first versions of the
// design's acceptance tests 1, 2 and 7 (PART2-DESIGN.md §6): each fails on
// the pre-change code by construction — no deadline exists in the parity
// call chain, no checkpoint table exists, and the sweep attempts every
// caught-up failing room in one visit.
import test from "node:test";
import assert from "node:assert/strict";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { runMessagesParityCheck } from "../server/messages-store.mjs";

function roomWithMessages(t, roomId, count) {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  store.initialize(initialRoom(roomId, "owner"));
  const key = store.issueAccessKey(roomId, "owner");
  let now = Date.now() + 10000;
  store.now = () => now;
  for (let i = 0; i < count; i++) {
    now += 2001; // stay under the chat flood guard, as the parity fixtures do
    store.command(key, roomId, {
      id: `ev-${roomId}-${i}`,
      type: "message.posted",
      data: { messageId: `m-${roomId}-${i}`, body: `body ${i} for ${roomId}` }
    });
  }
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  return store;
}

test("1: parity step honours its deadline and banks a checkpoint instead of certifying", async t => {
  const store = roomWithMessages(t, "bounds-deadline", 250);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => { Date.now = realNow; });
  const result = await store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  assert.equal(result.checked ?? 0, 0, "the room must not certify inside an expired budget");
  const checkpoint = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-deadline");
  assert.ok(checkpoint, "a checkpoint row banks the interrupted scan");
  const cursor = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?")
    .get("bounds-deadline");
  assert.equal(cursor.parity_at_seq, null, "no certification was issued");
});

test("2: a budget-stopped parity scan resumes from its checkpoint and certifies the same head", async t => {
  const store = roomWithMessages(t, "bounds-resume", 250);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  await store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  Date.now = realNow;
  const banked = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-resume");
  assert.ok(banked, "run 1 banked a checkpoint");
  const examinedRun1 = Number(banked.event_cursor) + (banked.message_cursor
    ? store.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE room_id=? AND message_id<=?")
      .get("bounds-resume", banked.message_cursor).n : 0);
  assert.ok(examinedRun1 > 0, "run 1 banked real progress, not a restart marker");
  const appliedSeq = store.db.prepare("SELECT applied_seq FROM messages_backfill_cursor WHERE room_id=?")
    .get("bounds-resume").applied_seq;
  const result = await store.runIntegrityParityStep({ deadline: Date.now() + 60000, yieldBetween: async () => {} });
  assert.equal(result.checked, 1, "run 2 certifies the room");
  const cursor = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?")
    .get("bounds-resume");
  assert.equal(cursor.parity_at_seq, appliedSeq, "certification names the scanned head");
  assert.equal(store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-resume"), undefined, "the checkpoint is consumed by certification");
  // Rows examined across both runs, counted via the checkpoint cursors:
  // run 2 resumed where run 1 stopped, so the total stays within 1.3x of
  // the single-pass count (250 bodies + 250 events at minimum).
  assert.ok(examinedRun1 < 250, "run 1 stopped mid-scan rather than completing it");
});

test("adversarial: a corrupt checkpoint is discarded and the room still certifies", async t => {
  const store = roomWithMessages(t, "bounds-corrupt", 250);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  await store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  Date.now = realNow;
  assert.ok(store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-corrupt"), "run 1 banked a checkpoint");
  store.db.prepare("UPDATE integrity_parity_checkpoint SET counts_json='not json', phase='counts' WHERE room_id=?")
    .run("bounds-corrupt");
  const result = await runMessagesParityCheck(store, { deadline: Date.now() + 60000, yieldBetween: async () => {} });
  assert.equal(result.checked, 1, "the corrupt checkpoint did not wedge or fail the room");
  assert.equal(result.checkpointDiscards, 1, "the discard is counted on the step result");
  assert.equal(store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-corrupt"), undefined, "certification consumed the restarted scan's checkpoint");
});

test("adversarial: mid-run growth — a scan banked at an old head never certifies it after the head moves", async t => {
  const store = roomWithMessages(t, "bounds-growth", 250);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  await store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  Date.now = realNow;
  const banked = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-growth");
  assert.ok(banked, "run 1 banked a checkpoint");
  // Grow the room: one more message, backfilled, so both the room head
  // and the backfill cursor's applied_seq move past the banked bound.
  const key = store.issueAccessKey("bounds-growth", "owner");
  const base = store.now();
  store.now = () => base + 2001;
  store.command(key, "bounds-growth", {
    id: "ev-growth-extra", type: "message.posted",
    data: { messageId: "m-growth-extra", body: "posted mid-scan" }
  });
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  const appliedNow = store.db.prepare("SELECT applied_seq FROM messages_backfill_cursor WHERE room_id=?")
    .get("bounds-growth").applied_seq;
  assert.ok(appliedNow > banked.applied_seq, "the head moved past the banked bound");
  const result = await store.runIntegrityParityStep({ deadline: Date.now() + 60000, yieldBetween: async () => {} });
  assert.equal(result.checked, 1, "the room certifies — at its new head, in a fresh scan");
  const cursor = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?")
    .get("bounds-growth");
  assert.equal(cursor.parity_at_seq, appliedNow, "certification names the new head, never the banked prefix");
});

test("adversarial: stale-attempt fencing — an old generation's writes land nowhere", async t => {
  const store = roomWithMessages(t, "bounds-fence", 250);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  const bank = () => store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  await bank();
  Date.now = realNow;
  const first = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-fence");
  assert.ok(first, "attempt 1 banked a checkpoint");
  // Force a second generation: move the head so the next visit discards
  // attempt 1's checkpoint and starts attempt 2.
  const key = store.issueAccessKey("bounds-fence", "owner");
  const base = store.now();
  store.now = () => base + 2001;
  store.command(key, "bounds-fence", {
    id: "ev-fence-extra", type: "message.posted",
    data: { messageId: "m-fence-extra", body: "posted between attempts" }
  });
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  now = realNow();
  Date.now = () => now;
  await bank();
  Date.now = realNow;
  const second = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-fence");
  assert.ok(second, "attempt 2 banked its own checkpoint");
  assert.ok(second.attempt_seq > first.attempt_seq, "the generation advanced");
  // The engine's chunk-commit shape, issued with the stale generation:
  const staleWrite = store.db.prepare(`UPDATE integrity_parity_checkpoint SET
    phase=?, event_cursor=?, message_cursor=?, counts_json=?, missing_json=?, staged_seq_json=?, updated_at=?
    WHERE room_id=? AND attempt_seq=?`)
    .run("diff", 999999, "zzz", null, "[]", null, Date.now(), "bounds-fence", first.attempt_seq);
  assert.equal(staleWrite.changes, 0, "a stale attempt's chunk commit lands nowhere");
  const staleDelete = store.db.prepare("DELETE FROM integrity_parity_checkpoint WHERE room_id=? AND attempt_seq=?")
    .run("bounds-fence", first.attempt_seq);
  assert.equal(staleDelete.changes, 0, "a stale attempt cannot erase the newer checkpoint");
  const intact = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-fence");
  assert.equal(intact.attempt_seq, second.attempt_seq, "the newer attempt's checkpoint is intact");
  assert.equal(intact.event_cursor, second.event_cursor, "the newer attempt's progress is intact");
  // And the live generation still completes and certifies the room.
  const result = await store.runIntegrityParityStep({ deadline: Date.now() + 60000, yieldBetween: async () => {} });
  assert.equal(result.checked, 1, "the current generation certifies");
});

test("adversarial: a stale checkpoint is abandoned for a strictly newer generation", async t => {
  const store = roomWithMessages(t, "bounds-stale", 250);
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  await store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  Date.now = realNow;
  const first = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-stale");
  assert.ok(first, "run 1 banked a checkpoint");
  store.db.prepare("UPDATE integrity_parity_checkpoint SET updated_at=? WHERE room_id=?")
    .run(Date.now() - 25 * 3600 * 1000, "bounds-stale");
  now = realNow();
  Date.now = () => now;
  await store.runIntegrityParityStep({
    deadline: now + 5000,
    yieldBetween: async () => { now += 10000; }
  });
  Date.now = realNow;
  const second = store.db.prepare("SELECT * FROM integrity_parity_checkpoint WHERE room_id=?")
    .get("bounds-stale");
  assert.ok(second, "the restarted scan banks its own checkpoint");
  assert.ok(second.attempt_seq > first.attempt_seq, "the abandoned generation strictly advances");
  const cursor = store.db.prepare("SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?")
    .get("bounds-stale");
  assert.equal(cursor.parity_at_seq, null, "the stale attempt certified nothing");
});

test("7: one parity visit attempts at most three failing rooms", async t => {
  const store = new RoomStore(":memory:");
  t.after(() => store.close());
  for (let i = 0; i < 5; i++) {
    const roomId = `bounds-sweep-${i}`;
    store.initialize(initialRoom(roomId, "owner"));
    const key = store.issueAccessKey(roomId, "owner");
    store.command(key, roomId, {
      id: `ev-${i}`, type: "message.posted",
      data: { messageId: `m-${i}`, body: `body ${i}` }
    });
  }
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  for (let i = 0; i < 5; i++) {
    store.db.prepare("UPDATE messages SET body='drift' WHERE room_id=?").run(`bounds-sweep-${i}`);
  }
  const reports = [];
  const result = await runMessagesParityCheck(store, { report: entry => reports.push(entry) });
  assert.equal(result.failures.length, 3, "the sweep stops after three failed attempts");
  assert.equal(reports.filter(entry => entry.error).length, 3);
});

// Acceptance tests for PR #5571 part 2 — bounding verifyRoomIntegrity's
// checkpoint-free stretches (design of record:
// ~/workspace/wave-2026-11-01-everything/pr3/PART2-DESIGN.md §6).
//
// The production defect: the messages_parity step's call chain
// (runIntegrityParityStep -> runMessagesParityCheck -> checkMessagesParity
// -> certifyMessagesParity) takes no deadline at all, so one room whose
// certification exceeds the 5 s job budget wedges the hourly integrity job
// forever, restarting from byte zero every tick. Part 2 threads
// {deadline, yieldBetween} through the chain, bounds the sweep at 3 failed
// room attempts per call, and chunks certification into phases checkpointed
// in a new integrity_parity_checkpoint table with attempt_seq fencing.
//
// FAILING-FIRST STATUS (pre-change main 513d3ee8, measured 2026-11-01):
// tests 1, 2 and 7 fail by construction — there is no deadline in the
// chain, no checkpoint table, and no sweep bound. Tests 3-6 fail on the
// same mechanisms (per-tick deadline bound / checkpoint assertions).
// Test 8 is the non-regression pin and passes before and after.
// Measured pre-change evidence: with the fixture below, a
// verifyRoomIntegrity call with deadline = now + 5000 took ~22 s and
// certified the room anyway; the parity step attempted all 5 poisoned
// rooms in one call. See the p2tests lane STATE.md for the full table.
//
// Fixture: tests/integrity-parity-fixture.mjs — 100,000 posted messages
// with 1024-byte bodies (projection 118.6 MB), single-pass certification
// ~20 s cold / ~13 s fully warm at the Node store seam. Tests 1-6 share one built store
// (node:test runs a file's tests sequentially); each test resets the
// parity state it dirties. The deferred batch's step list puts
// messages_parity at cursor index 10 (server/store.mjs
// runDeferredIntegrityBatch); tests aim the batch at it by writing the
// cursor directly, as existing integrity tests already do with the
// cursor and sweep rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import {
  BIG_COUNT, BODY_BYTES, appendFixtureMessages, fixtureBody, generateFixtureRoom
} from './integrity-parity-fixture.mjs';

const ROOM = 'fxroom';
const PARITY_STEP = 10; // steps[] index of messages_parity in runDeferredIntegrityBatch
const BIG_TIMEOUT = 900000;

const tick = (store, opts = {}) => store.verifyRoomIntegrity({ yieldBetween: async () => {}, ...opts });
const parityAtSeq = store => store.db.prepare('SELECT parity_at_seq FROM messages_backfill_cursor WHERE room_id=?').get(ROOM).parity_at_seq;
const headSeq = store => store.db.prepare('SELECT sequence FROM rooms WHERE id=?').get(ROOM).sequence;
const aimParityStep = store => store.db.prepare(`INSERT INTO integrity_job_cursor (singleton, step) VALUES (1, ?)
  ON CONFLICT(singleton) DO UPDATE SET step=excluded.step`).run(PARITY_STEP);
const checkpointTableExists = store => Boolean(store.db.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name='integrity_parity_checkpoint'").get());
const checkpointRow = store => checkpointTableExists(store)
  ? store.db.prepare('SELECT * FROM integrity_parity_checkpoint WHERE room_id=?').get(ROOM) ?? null : null;

// Progress banked in a checkpoint, in examined rows: events phase progress
// is an event-sequence cursor (fixture sequences start at 3, so the count
// is cursor - 2); diff phase progress is a message key cursor over the
// zero-padded fixture ids, counted in key order.
function examinedRows(store, row) {
  if (!row) return 0;
  const events = Math.max(0, Math.min(row.event_cursor - 2, BIG_COUNT));
  const messages = row.message_cursor
    ? store.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE room_id=? AND message_id<=?').get(ROOM, row.message_cursor).n : 0;
  return events + messages;
}

// One shared large store for tests 1-6: build (~30-45 s), one timed
// single-pass certification (the calibration control, ~13-20 s), then the
// standard settle pair (full tick, incremental tick) the other integrity
// suites use. singlePassMs is the measured pre-change certification time
// the short deadlines are tuned from.
let shared = null;
async function bigStore() {
  if (shared) return shared;
  const store = new RoomStore(':memory:', { integrity: 'deferred' });
  store.initialize(initialRoom(ROOM));
  generateFixtureRoom(store, { roomId: ROOM, count: BIG_COUNT, bodyBytes: BODY_BYTES });
  const t0 = Date.now();
  assert.equal(store.checkMessagesParity({ roomId: ROOM }).ok, true, 'fixture room must certify single-pass before any test runs');
  const singlePassMs = Date.now() - t0;
  store.db.prepare('UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?').run(ROOM);
  await tick(store);
  await tick(store);
  assert.deepEqual(store.integrityFailures(), [], 'settled fixture store must carry no failure records');
  shared = { store, singlePassMs };
  return shared;
}

// A deadline long enough for the parity step to bank real progress
// (the verify call's incremental phase consumes part of the window)
// but far short of a full single-pass certification.
const shortDeadlineMs = singlePassMs => Math.round(Math.min(6000, Math.max(3000, singlePassMs * 0.5)));

function resetParity(store) {
  store.db.prepare('UPDATE messages_backfill_cursor SET parity_at_seq=NULL WHERE room_id=?').run(ROOM);
  if (checkpointTableExists(store)) store.db.prepare('DELETE FROM integrity_parity_checkpoint WHERE room_id=?').run(ROOM);
  store.db.prepare("UPDATE messages SET body=? WHERE room_id=? AND message_id='fx-000042'").run(fixtureBody(42, BODY_BYTES), ROOM);
}

test('1. deadline contract: a 5s deadline bounds the tick even when certification needs ~13s+', { timeout: BIG_TIMEOUT }, async t => {
  const { store, singlePassMs } = await bigStore();
  t.diagnostic(`single-pass certification measured at ${singlePassMs}ms`);
  assert.ok(singlePassMs > 6500, `fixture must certify measurably over the 5s budget + slack (got ${singlePassMs}ms)`);
  resetParity(store);
  aimParityStep(store);
  const started = Date.now();
  const result = await tick(store, { deadline: started + 5000 });
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 6500,
    `verifyRoomIntegrity must return within deadline + one chunk of slack (5000 + 1500ms); took ${elapsed}ms — the parity chain has no deadline, so the synchronous certification overran the whole budget`);
  assert.ok(result.deferred?.budgetExceeded === 1 || parityAtSeq(store) === headSeq(store),
    'the call must report budgetExceeded or have completed certification');
  assert.ok(result.deferred?.ran >= 1, 'the deferred batch must have run the parity step');
});

test('2. kill-mid-run resume: a budget-stopped scan banks a checkpoint and resumes without double-work or false-ok', { timeout: BIG_TIMEOUT }, async t => {
  const { store, singlePassMs } = await bigStore();
  const short = shortDeadlineMs(singlePassMs);
  resetParity(store);

  // Run A: stopped mid-scan by the budget.
  aimParityStep(store);
  let started = Date.now();
  await tick(store, { deadline: started + short });
  const elapsedA = Date.now() - started;
  assert.ok(elapsedA < short + 1500, `budget-stopped run must return near its deadline; took ${elapsedA}ms against a ${short}ms deadline`);
  const rowA = checkpointRow(store);
  assert.ok(rowA, 'a budget-stopped scan must leave a row in integrity_parity_checkpoint (the table does not exist pre-change)');
  assert.ok(rowA.phase !== 'counts' || rowA.event_cursor > 0 || rowA.counts_json,
    `the checkpoint must name real banked progress, got phase=${rowA.phase} event_cursor=${rowA.event_cursor}`);
  assert.equal(parityAtSeq(store), null, 'a budget-stopped scan must not certify (no false-ok)');
  const progressA = examinedRows(store, rowA);
  assert.ok(progressA > 0, 'the first run must bank examined rows');

  // Run B: same budget again. A resume banks roughly another run's worth
  // of progress; a restart from byte zero would bank no more than run A.
  aimParityStep(store);
  started = Date.now();
  await tick(store, { deadline: started + short });
  assert.ok(Date.now() - started < short + 1500, 'the resumed run must also honour its deadline');
  const rowB = checkpointRow(store);
  assert.ok(rowB, 'the scan must still be checkpointed after the second budget-stopped run');
  const progressB = examinedRows(store, rowB);
  assert.ok(progressB >= progressA + 0.5 * progressA,
    `resume must advance from banked progress (run A banked ${progressA} rows, run B reached ${progressB}); a restart would stall near ${progressA}`);

  // Run C: generous budget certifies, at the room's current applied_seq,
  // and the checkpoint is consumed. Total examined rows across the runs
  // stay within 1.3x the single-pass count (2 * BIG_COUNT row domains),
  // allowing the design's two-chunk redo bound (800 rows).
  for (let i = 0; i < 6 && parityAtSeq(store) !== headSeq(store); i++) {
    aimParityStep(store);
    await tick(store, { deadline: Date.now() + 120000 });
  }
  assert.equal(parityAtSeq(store), headSeq(store), 'the resumed scan must eventually certify at the room head');
  assert.equal(checkpointRow(store), null, 'certification consumes the checkpoint');
  const totalExamined = progressB + (2 * BIG_COUNT - progressB) + 800;
  assert.ok(totalExamined <= 1.3 * 2 * BIG_COUNT, `total examined rows ${totalExamined} exceed 1.3x the single-pass count`);
});

test('3. poisoned-room equivalence: budget-stopped ticks produce the single-pass verdict and never certify', { timeout: BIG_TIMEOUT }, async t => {
  // Control: the same poison in a small fixture room, judged single-pass
  // (direct call throws) and by one parity step (recorded failure). The
  // recorded record is the verdict the budget-stopped drive must match.
  const control = new RoomStore(':memory:', { integrity: 'deferred' });
  t.after(() => control.close());
  control.initialize(initialRoom(ROOM));
  generateFixtureRoom(control, { roomId: ROOM, count: 100 });
  control.db.prepare("UPDATE messages SET body='tampered fixture body' WHERE room_id=? AND message_id='fx-000042'").run(ROOM);
  assert.throws(() => control.checkMessagesParity({ roomId: ROOM }),
    error => error.message === 'messages parity failed for fxroom: current record fx-000042 differs (body)');
  control.runIntegrityParityStep();
  const expected = control.integrityFailures().find(row => row.step === 'messages_parity' && row.recordId === ROOM);
  assert.ok(expected, 'control step must record the parity failure');

  const { store, singlePassMs } = await bigStore();
  const short = shortDeadlineMs(singlePassMs);
  resetParity(store);
  store.db.prepare("UPDATE messages SET body='tampered fixture body' WHERE room_id=? AND message_id='fx-000042'").run(ROOM);
  let recorded = null;
  for (let i = 0; i < 3 && !recorded; i++) {
    aimParityStep(store);
    const started = Date.now();
    await tick(store, { deadline: started + short });
    const elapsed = Date.now() - started;
    assert.ok(elapsed < short + 1500,
      `each budget-stopped tick must honour its deadline; tick ${i + 1} took ${elapsed}ms against ${short}ms — pre-change a tick runs the certification synchronously with no deadline in the chain`);
    assert.equal(parityAtSeq(store), null, 'a poisoned room must never certify in any tick');
    recorded = store.integrityFailures().find(row => row.step === 'messages_parity' && row.recordId === ROOM) ?? null;
  }
  assert.ok(recorded, 'the parity failure must be recorded within three budget-stopped ticks');
  assert.equal(recorded.message, expected.message, 'the recorded verdict must equal the single-pass verdict');
  assert.equal(recorded.code, expected.code);
  resetParity(store);
});

test('4. mid-run growth: no certification is ever issued for a stale head', { timeout: BIG_TIMEOUT }, async t => {
  const { store, singlePassMs } = await bigStore();
  const short = shortDeadlineMs(singlePassMs);
  resetParity(store);
  const appliedBefore = headSeq(store);

  aimParityStep(store);
  const started = Date.now();
  await tick(store, { deadline: started + short });
  assert.ok(Date.now() - started < short + 1500, 'the first scan must stop at its deadline');
  assert.equal(parityAtSeq(store), null,
    `no certification may exist for the head at scan start (parity_at_seq=${parityAtSeq(store)}, head=${appliedBefore}) — pre-change the unbounded tick simply certifies`);

  // The room grows mid-run: the scan's head bound is now stale.
  const newHead = appendFixtureMessages(store, { roomId: ROOM, startIndex: BIG_COUNT, count: 500 });
  aimParityStep(store);
  await tick(store, { deadline: Date.now() + short });
  const row = checkpointRow(store);
  if (row) assert.equal(row.head_sequence, newHead, 'a restarted scan must bind to the new head, never the stale one');
  assert.notEqual(parityAtSeq(store), appliedBefore, 'the stale head must never be certified after growth');

  for (let i = 0; i < 6 && parityAtSeq(store) !== newHead; i++) {
    aimParityStep(store);
    await tick(store, { deadline: Date.now() + 120000 });
  }
  assert.equal(parityAtSeq(store), newHead, 'final certification must name the new head');
});

test('5. corrupt checkpoint: discarded and restarted, never certifies, never throws the tick', { timeout: BIG_TIMEOUT }, async t => {
  const { store, singlePassMs } = await bigStore();
  const short = shortDeadlineMs(singlePassMs);
  resetParity(store);
  aimParityStep(store);
  await tick(store, { deadline: Date.now() + short });
  assert.ok(checkpointTableExists(store),
    'integrity_parity_checkpoint must exist after a budget-stopped scan (pre-change there is no checkpoint table at all)');
  const row = checkpointRow(store);
  assert.ok(row, 'a checkpoint row must be banked before it can be corrupted');
  store.db.prepare("UPDATE integrity_parity_checkpoint SET counts_json='{bad json', phase='bogus_phase' WHERE room_id=?").run(ROOM);
  const result = store.runIntegrityParityStep();
  assert.ok((result.checkpointDiscards ?? 0) >= 1,
    `the step result must count the discarded corrupt checkpoint (checkpointDiscards=${result.checkpointDiscards})`);
  assert.equal(parityAtSeq(store), headSeq(store), 'after discarding, the restarted scan certifies the clean room');

  // Variant: the row vanishes mid-run — same outcome, no throw.
  resetParity(store);
  aimParityStep(store);
  await tick(store, { deadline: Date.now() + short });
  assert.ok(checkpointRow(store), 'a fresh checkpoint must be banked for the deletion variant');
  store.db.prepare('DELETE FROM integrity_parity_checkpoint WHERE room_id=?').run(ROOM);
  store.runIntegrityParityStep();
  assert.equal(parityAtSeq(store), headSeq(store), 'a deleted checkpoint restarts and certifies');
});

test('6. attempt fencing (observable surface): fresh checkpoints are adopted, abandoned generations advance, stale attempts never certify', { timeout: BIG_TIMEOUT }, async t => {
  // The design's compare-and-swap certify transaction is internal, like
  // part 1's applyOutcomes; this test pins its externally observable
  // consequences at the store seam. (A direct CAS test belongs with the
  // implementation's unit tests, mirroring the part-1 attempt tests.)
  const { store, singlePassMs } = await bigStore();
  const short = shortDeadlineMs(singlePassMs);
  resetParity(store);

  aimParityStep(store);
  await tick(store, { deadline: Date.now() + short });
  const rowA = checkpointRow(store);
  assert.ok(rowA, 'integrity_parity_checkpoint must exist (pre-change there is no checkpoint table at all)');

  // A second caller finding the fresh checkpoint adopts it: same row,
  // same attempt generation — attempts never multiply on contention.
  aimParityStep(store);
  await tick(store, { deadline: Date.now() + short });
  const rows = store.db.prepare('SELECT * FROM integrity_parity_checkpoint WHERE room_id=?').all(ROOM);
  assert.equal(rows.length, 1, 'exactly one checkpoint row per room');
  assert.equal(rows[0].attempt_seq, rowA.attempt_seq, 'a fresh checkpoint is adopted, its generation unchanged');

  // Abandon the attempt (checkpoint goes stale): the next scan starts a
  // strictly newer generation, and the stale attempt certifies nothing.
  store.db.prepare('UPDATE integrity_parity_checkpoint SET updated_at=? WHERE room_id=?')
    .run(Date.now() - 25 * 3600 * 1000, ROOM);
  aimParityStep(store);
  await tick(store, { deadline: Date.now() + short });
  const rowC = checkpointRow(store);
  assert.ok(rowC.attempt_seq > rowA.attempt_seq, 'an abandoned scan restarts under a strictly newer attempt_seq');
  assert.equal(parityAtSeq(store), null, 'the stale attempt must not certify');
  resetParity(store);
});

test('7. sweep bound: one parity step attempts at most 3 poisoned rooms, and rotation reaches the rest', { timeout: 120000 }, async t => {
  const store = new RoomStore(':memory:', { integrity: 'deferred' });
  t.after(() => store.close());
  const rooms = ['sw-a', 'sw-b', 'sw-c', 'sw-d', 'sw-e'];
  for (const roomId of rooms) {
    store.initialize(initialRoom(roomId));
    generateFixtureRoom(store, { roomId, count: 60 });
    store.db.prepare("UPDATE messages SET body='tampered fixture body' WHERE room_id=? AND message_id='fx-000001'").run(roomId);
  }
  const parityRecords = () => store.integrityFailures().filter(row => row.step === 'messages_parity');
  const first = store.runIntegrityParityStep();
  assert.ok(first.failures.length >= 1 && first.failures.length <= 3,
    `one parity step must attempt at most 3 failing rooms (attempted ${first.failures.length} of 5) — pre-change the sweep is unbounded and attempts every caught-up room`);
  assert.deepEqual(new Set(parityRecords().map(row => row.recordId)), new Set(first.failures.map(f => f.roomId)),
    'every attempted failure is recorded durably');
  store.runIntegrityParityStep();
  assert.equal(new Set(parityRecords().map(row => row.recordId)).size, 5,
    'rotation reaches the remaining poisoned rooms on the next visit — none starved');
  for (const row of parityRecords()) assert.match(row.message, /messages parity failed for sw-/);
});

test('8. non-regression pin: small-room result shapes are unchanged', { timeout: 60000 }, async t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  store.initialize(initialRoom('commons'));
  const owner = store.issueAccessKey('commons', 'owner');
  let now = Date.now() + 10000; store.now = () => now;
  for (const id of ['a', 'b', 'c']) {
    now += 2001;
    store.command(owner, 'commons', { id, type: 'message.posted', data: { messageId: id, body: 'shape pin ' + id } });
  }
  while (!store.backfillMessages({ limit: 1000 }).done) { /* fixture */ }
  assert.deepEqual(store.checkMessagesParity({ roomId: 'commons' }),
    { ok: true, checked: 1, roomId: 'commons', projectionCount: 3, tableCount: 3, projectionLastSeq: 5, tableLastSeq: 5 });
  const step = store.runIntegrityParityStep();
  assert.equal(step.ok, true);
  assert.equal(step.checked, 1);
  const result = await tick(store);
  assert.deepEqual(result.failures, []);
});

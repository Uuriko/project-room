import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

function fixture(t) {
  const fixedNow = Date.now();
  const store = new RoomStore(':memory:', { now: () => fixedNow });
  t.after(() => store.close());
  store.initialize(initialRoom('alpha'));
  store.roomFlood = { consume() {} };
  const key = store.issueAccessKey('alpha', 'owner');
  const post = id => store.command(key, 'alpha', { id: `cmd-${id}`, type: 'message.posted', data: { body: id, messageId: id } });
  post('prior');
  const prior = store.db.prepare("SELECT sequence, body FROM events WHERE room_id=? AND json_extract(body,'$.data.messageId')=?").get('alpha', 'prior');
  const priorKey = JSON.parse(prior.body).idempotencyKey;
  assert.equal(typeof priorKey, 'string');
  store.patrolTick();
  const baseline = store.db.prepare('SELECT sequence FROM patrol_cursor WHERE room_id=?').get('alpha').sequence;
  for (let i = 0; i < 60; i++) post(`later-${i}`);
  const duplicate = store.db.prepare("SELECT id, sequence, body FROM events WHERE room_id=? AND json_extract(body,'$.data.messageId')=?").get('alpha', 'later-10');
  const body = JSON.parse(duplicate.body);
  body.idempotencyKey = priorKey;
  // Local injected corruption follows the existing patrol idempotency test.
  store.db.prepare('UPDATE events SET body=? WHERE id=?').run(JSON.stringify(body), duplicate.id);
  const detected = () => store.patrolFindings().some(f => f.kind === 'idempotency_duplicate' && f.sequence === duplicate.sequence);
  const cursor = () => store.db.prepare('SELECT sequence FROM patrol_cursor WHERE room_id=?').get('alpha').sequence;
  return { store, baseline, duplicateSequence: duplicate.sequence, detected, cursor };
}

test('control: uninterrupted patrol detects the injected cross-batch duplicate', t => {
  const f = fixture(t);
  const result = f.store.patrolTick();
  assert.equal(result.errors, undefined);
  assert.equal(f.detected(), true);
});

test('deadline cutoff must not lose cross-batch duplicate detection after resume', t => {
  const f = fixture(t);
  const realNow = Date.now;
  let clockReads = 0;
  let interrupted;
  const snapshot = () => Object.fromEntries(['patrol_cursor', 'patrol_claims', 'patrol_messages', 'patrol_findings'].map(table => [table, f.store.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const before = snapshot();
  try {
    // First check admits the room; the next check after 50 events exhausts budget.
    // No sleeps, real-time threshold, or production source changes are involved.
    Date.now = () => ++clockReads === 1 ? 0 : 2;
    interrupted = f.store.patrolTick({ deadline: 1 });
  } finally { Date.now = realNow; }
  const afterCutoff = f.cursor();
  assert.equal(interrupted.budgetExceeded, 1);
  assert.equal(interrupted.checked, 0, 'unchecked prefix must not count as checked');
  assert.equal(afterCutoff, f.baseline, 'deadline must leave the durable cursor unchanged');
  assert.deepEqual(snapshot(), before, 'deadline must commit neither shadows nor findings');
  const resumed = f.store.patrolTick();
  assert.equal(resumed.errors, undefined);
  console.log(JSON.stringify({ baseline: f.baseline, duplicateSequence: f.duplicateSequence,
    cutoffChecked: interrupted.checked, cutoffCursor: afterCutoff,
    resumedChecked: resumed.checked, finalCursor: f.cursor(), detected: f.detected() }));
  assert.equal(f.detected(), true, 'committed prefix must receive cross-batch duplicate verification before or after resume');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { jobByName, jobEnabled, jobDisabledReason, earliestFutureAlarm } from '../server/jobs.mjs';
import { selectWorkerJobs, jobHealthView, applyOutcomes } from '../cloudflare/job-heartbeat.mjs';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

test('only exact string zero disables scheduled patrol before any eligibility, due or health scan', async () => {
  const patrol = jobByName('patrol');
  let reads = 0;
  const store = { db: { prepare(sql) { if (/patrol_/i.test(sql)) reads++; throw new Error('unexpected patrol database access'); } } };
  const env = { ROOM_PATROL_ENABLED: '0', ROOM_BACKUPS_KV: { put() {}, get() {} } };
  assert.equal(jobEnabled(patrol, env, store), false);
  assert.match(jobDisabledReason(patrol, env, store), /ROOM_PATROL_ENABLED=0/);
  assert.deepEqual(selectWorkerJobs(env, store, { onlyJob: 'patrol' }), []);
  assert.equal(earliestFutureAlarm([patrol], { env, store, now: Date.now(), lastRan: {} }), null);
  const history = applyOutcomes({}, [{ job: 'patrol', ok: false, at: Date.now()-1000, error: 'prior failure' }]);
  const view = jobHealthView(history, Date.now(), env, store).jobs.find(job => job.name === 'patrol');
  assert.equal(view.status, 'disabled');assert.match(view.reason, /ROOM_PATROL_ENABLED=0/);
  assert.equal(view.lastError, 'prior failure');assert.equal(view.pendingSinceAt, null);
  assert.equal(reads, 0, 'health and scheduling never reach patrol SQL');
  assert.deepEqual(await patrol.run(store, { env }), { skipped: 1, disabled: 1 });
  for (const value of [undefined, '', 'false', '00', ' 0', 0, false, '1']) {
    assert.equal(jobEnabled(patrol, { ROOM_PATROL_ENABLED: value }, null), true, String(value));
  }
  assert.equal(jobEnabled(jobByName('integrity'), env, null), true);
  assert.equal(jobEnabled(jobByName('room-backup'), env, null), true);
});

test('disabled scheduled run preserves patrol state and manual recheck remains available', async t => {
  const store = new RoomStore(':memory:');t.after(() => store.close());
  store.initialize(initialRoom('opt-out'));
  store.patrolTick();
  const key = store.issueAccessKey('opt-out', 'owner');
  store.command(key, 'opt-out', { id: 'new-message', type: 'message.posted', data: { body: 'Synthetic pending patrol work' } });
  const state = () => ['patrol_cursor', 'patrol_findings', 'patrol_blocks'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all());
  const before = state();
  await jobByName('patrol').run(store, { env: { ROOM_PATROL_ENABLED: '0' } });
  assert.deepEqual(state(), before);
  assert.equal(jobEnabled(jobByName('patrol'), {}, store), true, 'pending work resumes when override removed');
  store.patrolTick({ roomId: 'opt-out' });
  assert.notDeepEqual(state()[0], before[0], 'manual store recheck still advances existing cursor');
});

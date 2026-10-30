import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { JOBS } from '../server/jobs.mjs';
import { mcpEventSubscriptionsSchema } from '../server/mcp-event-subscriptions.mjs';
import { applyOutcomes, jobHealthView, selectWorkerJobs } from '../cloudflare/job-heartbeat.mjs';

test('idle terminal native callback failure remains degraded without rescheduling dead work', () => {
  const store = new RoomStore(':memory:');
  try {
    store.initialize(initialRoom('commons')); store.patrolTick();
    store.db.exec(mcpEventSubscriptionsSchema); store.nativeMcpEventsEnabled = true;
    const now = Date.parse('2026-10-30T22:00:00Z');
    const env = { ROOM_GMAIL_ENABLED: '0', ROOM_BACKUPS_KV: { async put() {}, async get() { return null; } } };
    const fresh = applyOutcomes({}, ['retention', 'integrity', 'public-read-model', 'room-backup', 'store-growth']
      .map(job => ({ job, ok: true, at: now, summary: { checked: 1 } })));
    const native = view => view.jobs.find(row => row.name === 'native-mcp-events');
    const job = JOBS.find(row => row.name === 'native-mcp-events');
    assert.equal(native(jobHealthView(fresh, now, env, store)).status, 'disabled');
    store.db.prepare("INSERT INTO mcp_event_outbox(subscription_id,event_id,document,state,next_at) VALUES('s','e','{}','dead',?)").run(now);
    for (const terminal of ['exhausted', 'dead']) {
      const failed = applyOutcomes(fresh, [{ job: job.name, ok: false, at: now, error: '1 error(s) in tick', summary: { checked: 1, errors: 1, [terminal]: 1 } }]);
      const view = jobHealthView(failed, now, env, store);
      assert.equal(view.status, 'degraded');
      assert.equal(native(view).status, 'degraded');
      assert.equal(native(view).degraded, 'native_callback_failed');
      assert.equal(native(view).lastErrorCurrent, true);
      assert.equal(native(view).stale, false);
      assert.equal(job.enabled(env, store), false);
      assert.equal(job.nextDueAt(store), null);
      assert.equal(selectWorkerJobs(env, store).some(row => row.name === job.name), false);
      store.nativeMcpEventsEnabled = false;
      assert.equal(native(jobHealthView(failed, now, env, store)).status, 'disabled');
      assert.equal(jobHealthView(failed, now, env, store).status, 'ok');
      store.nativeMcpEventsEnabled = true;
      const recovered = applyOutcomes(failed, [{ job: job.name, ok: true, at: now, summary: { checked: 1, delivered: 1, errors: 0 } }]);
      assert.equal(native(jobHealthView(recovered, now, env, store)).status, 'disabled');
      assert.equal(native(jobHealthView(recovered, now, env, store)).lastErrorCurrent, false);
    }
  } finally { store.close(); }
});

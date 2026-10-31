import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createSchedulerDiagnostics, readSchedulerDiagnostics } from '../cloudflare/job-scheduler-diagnostics.mjs';
import { createJobAlarmReconciler } from '../cloudflare/job-alarm-reconciler.mjs';
import { mcpEventSubscriptionsSchema } from '../server/mcp-event-subscriptions.mjs';

test('scheduler diagnostics preserve failure and success semantics without logging error details', async () => {
  let at = 100; const logs = [];
  const diagnostics = createSchedulerDiagnostics({ now: () => at, warn: value => logs.push(value) });
  const error = new Error('secret callback path /private?token=secret');
  await assert.rejects(diagnostics.reconcile(() => { throw error; }), value => value === error);
  assert.deepEqual(JSON.parse(logs[0]), { event: 'room.scheduler_reconciliation_failed', code: 'alarm_reconciliation_failed', at: 100, stage: null });
  assert.equal(diagnostics.snapshot().failureCurrent, true);
  at = 200; const outcome = { armed: true, alarmAt: 250 };
  assert.equal(await diagnostics.reconcile(async () => outcome), outcome);
  assert.deepEqual(diagnostics.snapshot(), { scope: 'current-isolate', lastSuccessAt: 200, lastSuccessfulAlarmAt: 250,
    lastFailureAt: 100, lastFailureCode: 'alarm_reconciliation_failed', lastFailureStage: null, stage: null, failureCurrent: false });
  const unavailableLogger = createSchedulerDiagnostics({ warn: () => { throw new Error('sink unavailable'); } });
  await assert.rejects(unavailableLogger.reconcile(async () => { throw error; }), value => value === error);
});

test('scheduler health reads current alarm and aggregate queue without arming or exposing rows', async () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(mcpEventSubscriptionsSchema);
    const insert = db.prepare('INSERT INTO mcp_event_outbox(subscription_id,event_id,document,state,attempts,next_at,lease_until) VALUES(?,?,?,?,?,?,?)');
    for (const [state, attempts, nextAt, leaseUntil] of [['pending', 2, 100, null], ['leased', 3, 50, 150], ['delivered', 1, 1, null], ['dead', 8, 1, null]])
      insert.run('private-subscription', state, '{"secret":"private-signing-secret"}', state, attempts, nextAt, leaseUntil);
    let reads = 0; const storage = { getAlarm: async () => { reads++; return 99; }, setAlarm: () => assert.fail('read must not arm'), deleteAlarm: () => assert.fail('read must not delete') };
    const result = await readSchedulerDiagnostics({ storage, store: { db, nativeMcpEventsEnabled: true } });
    assert.equal(reads, 1); assert.equal(result.alarmAt, 99); assert.equal(result.lastSuccessAt, null);
    assert.deepEqual(result.nativeEvents, { enabled: true, readError: null, counts: { pending: 1, leased: 1, delivered: 1, dead: 1, oldestDueAt: 100, maxPendingAttempts: 3 } });
    assert.equal(JSON.stringify(result).includes('private-'), false);
    const failed = await readSchedulerDiagnostics({ storage: { getAlarm: async () => { throw new Error('private storage path'); } }, store: { db: { prepare: () => { throw new Error('private SQL'); } } } });
    assert.equal(failed.alarmReadError, 'alarm_read_failed'); assert.equal(failed.nativeEvents.readError, 'native_queue_read_failed');
    assert.equal(failed.nativeEvents.counts, null); assert.equal(JSON.stringify(failed).includes('private'), false);
  } finally { db.close(); }
});

for (const phase of ['calculate', 'get_alarm', 'set_alarm', 'delete_alarm']) test('scheduler failure stage is safe and exact: ' + phase, async () => {
  const secret = new Error('private failure detail');
  const diagnostics = createSchedulerDiagnostics({ warn: () => {} });
  const fail = async () => { throw secret; };
  const storage = { getAlarm: phase === 'get_alarm' ? fail : async () => phase === 'delete_alarm' ? 1 : null,
    setAlarm: phase === 'set_alarm' ? fail : async () => {}, deleteAlarm: phase === 'delete_alarm' ? fail : async () => {} };
  const reconcile = createJobAlarmReconciler({ storage, yieldTurn: async () => {},
    calculate: phase === 'calculate' ? fail : async () => phase === 'delete_alarm' ? null : 10,
    observeStage: stage => diagnostics.observeStage(stage) });
  await assert.rejects(diagnostics.reconcile(reconcile), error => error === secret);
  assert.equal(diagnostics.snapshot().lastFailureStage, phase);
  assert.equal(JSON.stringify(diagnostics.snapshot()).includes('private'), false);
});

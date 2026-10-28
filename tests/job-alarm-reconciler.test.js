import test from 'node:test';
import assert from 'node:assert/strict';
import { createJobAlarmReconciler } from '../cloudflare/job-alarm-reconciler.mjs';
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
function fixture() {
  let alarm = 500, due = 1000, reads = 0;
  const writes = [];
  const storage = { getAlarm: async () => alarm, setAlarm: async value => { writes.push(['set', value]); alarm = value; }, deleteAlarm: async () => { writes.push(['delete']); alarm = null; } };
  const request = createJobAlarmReconciler({ storage, calculate: async () => { reads++; return due; }, now: () => 100, yieldTurn: async () => {} });
  return { storage, request, writes, setDue: value => { due = value; }, alarm: () => alarm, reads: () => reads };
}
test('overlapping decisions share a drain and an earlier mutation wins', async () => {
  const f = fixture(), gate = deferred(); let first = true;
  f.storage.getAlarm = async () => { if (first) { first = false; await gate.promise; } return f.alarm(); };
  const p = f.request(); await new Promise(resolve => setImmediate(resolve));
  f.setDue(200); const q = f.request(); assert.equal(p, q); gate.resolve();
  assert.equal((await p).alarmAt, 200); assert.equal(f.alarm(), 200);
  assert.deepEqual(f.writes, [['set', 200]]);
});
test('a stale empty decision cannot delete a newly needed alarm', async () => {
  const f = fixture(), gate = deferred(); f.setDue(null);
  f.storage.getAlarm = async () => { await gate.promise; return f.alarm(); };
  const p = f.request(); await new Promise(resolve => setImmediate(resolve));
  f.setDue(200); f.request(); gate.resolve(); await p;
  assert.deepEqual(f.writes, [['set', 200]]);
});
test('mutation during delete is reconciled before shared completion', async () => {
  const f = fixture(), gate = deferred(), original = f.storage.deleteAlarm;
  f.setDue(null); f.storage.deleteAlarm = async () => { await gate.promise; await original(); };
  const p = f.request(); await new Promise(resolve => setImmediate(resolve));
  f.setDue(150); f.request(); gate.resolve(); await p;
  assert.equal(f.alarm(), 150); assert.deepEqual(f.writes, [['delete'], ['set', 150]]);
});
test('failed storage retains retry deadline and later calls retry fresh', async () => {
  const f = fixture(); f.setDue(null); const original = f.storage.getAlarm;
  f.storage.getAlarm = async () => { throw new Error('storage unavailable'); };
  await assert.rejects(f.request({ retryDelayMs: 50 }), /unavailable/);
  f.storage.getAlarm = original; await f.request(); assert.equal(f.alarm(), 150);
  f.setDue(120); await f.request(); assert.equal(f.alarm(), 120);
});
test('idle deletes an alarm, existing earlier alarm is retained, and completion does not cache eligibility', async () => {
  const f = fixture(); await f.request(); assert.equal(f.alarm(), 500); assert.deepEqual(f.writes, []);
  f.setDue(null); await f.request(); assert.equal(f.alarm(), null); assert.equal(f.reads(), 2);
});
test('new work during set is reconciled and does not resolve at the old deadline', async () => {
  const f = fixture(), gate = deferred(), original = f.storage.setAlarm;
  f.setDue(300); let first = true;
  f.storage.setAlarm = async value => { if (first) { first = false; await gate.promise; } await original(value); };
  const p = f.request(); await new Promise(resolve => setImmediate(resolve));
  f.setDue(120); f.request(); gate.resolve();
  assert.equal((await p).alarmAt, 120); assert.deepEqual(f.writes, [['set', 300], ['set', 120]]);
});
test('overlapping reads do not prevent a known deadline being armed', async () => {
  const f = fixture(), original = f.storage.getAlarm;
  f.setDue(200); let overlaps = 3;
  f.storage.getAlarm = async () => { if (overlaps-- > 0) f.request(); return original(); };
  await f.request(); assert.equal(f.alarm(), 200);
  assert.deepEqual(f.writes, [['set', 200]]);
});
test('uncertain delete completion is recovered by fresh eligibility on the next request', async () => {
  const f = fixture(), original = f.storage.deleteAlarm; f.setDue(null);
  f.storage.deleteAlarm = async () => { await original(); throw new Error('completion unknown'); };
  await assert.rejects(f.request(), /completion unknown/); assert.equal(f.alarm(), null);
  f.setDue(180); await f.request(); assert.equal(f.alarm(), 180);
});
test('coalesced retry requests preserve the earliest requested recovery deadline', async () => {
  const f = fixture(); f.setDue(null);
  const p = f.request({ retryDelayMs: 80 }); const q = f.request({ retryDelayMs: 20 });
  await Promise.all([p, q]); assert.equal(f.alarm(), 120);
});

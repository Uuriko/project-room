import test from 'node:test';
import assert from 'node:assert/strict';
import { planLocalWork } from '../client/local-work-planner.mjs';
const now = Date.parse('2026-11-10T19:00:00Z');
const device = (id, extra = {}) => ({ id, fingerprint: id.repeat(16), verified: true, available: true,
  observedAt: new Date(now).toISOString(), capabilities: ['node'], ...extra });
const job = (id, extra = {}) => ({ id, source: `pr:${id}`, revision: 'head1', acceptance: 'Exact-head test evidence',
  valueReason: 'Unblocks selected MVP path', value: 5, minutes: 10, requires: ['node'], dependencies: [], scopes: [`repo/${id}`], ...extra });
const plan = extra => planLocalWork({ now, devices: [device('a'), device('b')], jobs: [job('one'), job('two')], ...extra });

test('balances bounded useful work across two fresh verified devices without authorizing dispatch', () => {
  const result = plan({ jobs: ['one', 'two', 'three', 'four', 'five'].map(id => job(id)) });
  assert.equal(result.assignments.length, 4);
  assert.deepEqual(result.coverage.map(d => d.queuedTasks), [2, 2]);
  assert.equal(result.executionAuthorized, false);
});
test('busy, offline, stale, future and duplicate physical runtimes do not create capacity', () => {
  for (const override of [{available:false}, {verified:false}, {observedAt:new Date(now-120001).toISOString()}, {observedAt:new Date(now+1).toISOString()}])
    assert.equal(plan({ devices:[device('a', override)] }).assignments.length, 0);
  assert.equal(plan({ devices:[device('a'), device('b',{fingerprint:'a'.repeat(16)})] }).coverage.length, 1);
  assert.equal(plan({ devices:[device('a'), device('b',{fingerprint:'a'.repeat(16)})], reservations:[{deviceId:'a',source:'old',revision:'1',scopes:['elsewhere']}]}).assignments.length, 0);
});
test('verified results dedupe exact revisions; changed revisions become candidates again', () => {
  const receipts = [{source:'pr:one',revision:'head1',status:'verified',evidence:'https://example.test/result'}];
  assert.equal(plan({receipts}).assignments.length, 1);
  assert.equal(plan({receipts,jobs:[job('one',{revision:'head2'})]}).assignments.length, 1);
  assert.throws(() => plan({receipts:[{...receipts[0],evidence:''}]}));
});
test('dependencies need verified evidence and duplicate source revisions only queue once', () => {
  assert.equal(plan({jobs:[job('one',{dependencies:['pr:base@head1']})]}).assignments.length, 0);
  assert.equal(plan({jobs:[job('one'),job('alias',{source:'pr:one'})]}).assignments.length, 1);
});
test('unknown outcomes and overlapping scopes block redispatch even after a lease timestamp', () => {
  const reservations = [{deviceId:'x',source:'pr:one',revision:'head1',scopes:['repo'],expiredAt:'2020-01-01'}];
  assert.equal(plan({reservations}).assignments.length, 0);
  const result=plan({jobs:[job('one',{scopes:['repo/shared']}),job('two',{scopes:['repo/shared/file']})]});
  assert.equal(new Set(result.assignments.map(a=>a.deviceId)).size, 1);
});
test('capability and value limits prevent filler or unsuitable work', () => {
  assert.equal(plan({jobs:[job('one',{requires:['mac-browser']})]}).assignments.length, 0);
  assert.throws(()=>plan({jobs:[job('one',{value:0})]}));
  assert.throws(()=>plan({jobs:[job('one',{minutes:1000})]}));
  assert.throws(()=>plan({jobs:[job('one',{acceptance:''})]}));
});

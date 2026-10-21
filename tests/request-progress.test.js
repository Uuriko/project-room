import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequestProgress } from '../src/request-progress.js';

function fixture() {
  let current = { generation: 1, roomId: 'a', viewerId: 'person', openIds: ['request'] };
  const pending = [];
  const progress = createRequestProgress({ context: () => current, changed() {}, read: () => new Promise((resolve, reject) => pending.push({ resolve, reject })) });
  return { progress, pending, set: value => { current = value; }, view: (roomId, state) => ({ roomId, viewerId: 'person', runs: { request: { state } } }) };
}
test('new room reads immediately and old completion cannot unlock its pending read', async () => {
  const f = fixture(), old = f.progress.refresh();
  f.set({ generation: 2, roomId: 'b', viewerId: 'person', openIds: ['request'] });
  const next = f.progress.refresh();
  assert.equal(f.pending.length, 2);
  f.pending[0].resolve(f.view('a', 'working'));
  await old;
  await f.progress.refresh({ force: true });
  assert.equal(f.pending.length, 2);
  assert.deepEqual(f.progress.runs, {});
  f.pending[1].resolve(f.view('b', 'result_ready'));
  await next;
  assert.equal(f.progress.runs.request.state, 'result_ready');
});
test('sign out invalidates an outstanding read, including return to the same room', async () => {
  const f = fixture(), old = f.progress.refresh();
  f.progress.reset();
  f.pending[0].resolve(f.view('a', 'working'));
  await old;
  assert.deepEqual(f.progress.runs, {});
});
test('unchanged request sets coalesce; failed reads retry only when forced', async () => {
  const f = fixture(), first = f.progress.refresh();
  await f.progress.refresh();
  assert.equal(f.pending.length, 1);
  f.pending[0].reject(new Error('offline'));
  await first;
  await f.progress.refresh();
  assert.equal(f.pending.length, 1);
  const retry = f.progress.refresh({ force: true });
  f.pending[1].resolve(f.view('a', 'working'));
  await retry;
  assert.equal(f.progress.runs.request.state, 'working');
});
test('requests arriving during a read trigger one follow-up read', async () => {
  const f = fixture(), first = f.progress.refresh();
  f.set({ generation: 1, roomId: 'a', viewerId: 'person', openIds: ['request', 'new'] });
  f.pending[0].resolve(f.view('a', 'working'));
  await first;
  assert.equal(f.pending.length, 2);
  f.pending[1].resolve(f.view('a', 'result_ready'));
});
test('closing all requests clears data and rejects an earlier result', async () => {
  const f = fixture(), first = f.progress.refresh();
  f.set({ generation: 1, roomId: 'a', viewerId: 'person', openIds: [] });
  await f.progress.refresh();
  f.pending[0].resolve(f.view('a', 'working'));
  await first;
  assert.deepEqual(f.progress.runs, {});
});

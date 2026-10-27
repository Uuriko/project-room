import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { createWork, claimWork } from '../server/work-claims.mjs';
import { SOURCE_REVISION } from '../server/version.mjs';

async function fixture(t) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom('commons'));
  const token = store.issueAccessKey('commons', 'owner');
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const call = (path = '', body) => fetch(origin + '/api/rooms/commons/work-claims' + path, {
    method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(body ? { body: JSON.stringify(body) } : {}) });
  return { store, call };
}
function expired(id) {
  const now = Date.now() - 3 * 3600000;
  return claimWork(createWork({ id, repo: 'Uuriko/project-room' }, { now, agentId: 'owner' }), 'owner', { now, leaseHours: 1 });
}

test('HTTP maintenance skips invalid expired rows, releases valid leases, and permits unrelated writes', async t => {
  const f = await fixture(t), warnings = [];
  t.mock.method(console, 'warn', line => warnings.push(JSON.parse(line)));
  const poisoned = { ...expired('codex-room-followthrough-1026'), state: 'in_progress', repo: 'https://github.com/Uuriko/project-room' };
  f.store.workClaims.set('commons', poisoned);
  for (let i = 0; i < 6; i++) f.store.workClaims.set('commons', { ...poisoned, id: `invalid-${i}` });
  f.store.workClaims.set('commons', expired('valid-expiry'));
  const before = f.store.workClaims.get('commons', poisoned.id);
  const response = await f.call(); assert.equal(response.status, 200);
  assert.ok((await response.json()).swept.includes('valid-expiry'));
  assert.equal(f.store.workClaims.get('commons', 'valid-expiry').state, 'unclaimed');
  assert.deepEqual(f.store.workClaims.get('commons', poisoned.id), before);
  assert.equal(warnings.length, 1); assert.equal(warnings[0].skippedCount, 7);
  assert.equal(warnings[0].phase, 'lease_expiry'); assert.equal(warnings[0].claimIds.length, 5);
  assert.equal((await f.call('/' + poisoned.id)).status, 200);
  assert.equal((await f.call('', { id: 'unrelated-new', repo: 'Uuriko/project-room' })).status, 201);
  assert.deepEqual(f.store.workClaims.get('commons', poisoned.id), before);
});

test('HTTP live-close isolates malformed land rows while closing a valid matching revision', async t => {
  const f = await fixture(t), warnings = [];
  t.mock.method(console, 'warn', line => warnings.push(JSON.parse(line)));
  const valid = createWork({ id: 'valid-land', kind: 'land', revision: SOURCE_REVISION }, { now: Date.now(), agentId: 'owner' });
  const poisoned = { ...valid, id: 'invalid-land', repo: 'https://github.com/Uuriko/project-room' };
  f.store.workClaims.set('commons', poisoned); f.store.workClaims.set('commons', valid);
  const before = f.store.workClaims.get('commons', poisoned.id);
  const response = await f.call(); assert.equal(response.status, 200);
  assert.equal(f.store.workClaims.get('commons', valid.id).state, 'done');
  assert.deepEqual(f.store.workClaims.get('commons', poisoned.id), before);
  assert.ok(warnings.some(warning => warning.phase === 'live_close' && warning.claimIds.includes('invalid-land')));
});

test('HTTP lease maintenance does not swallow persistence failures', async t => {
  const f = await fixture(t); f.store.workClaims.set('commons', expired('valid-expiry'));
  t.mock.method(f.store.workClaims, 'set', () => { throw new Error('synthetic storage failure'); });
  const response = await f.call(); assert.equal(response.status, 500);
  assert.equal(f.store.workClaims.get('commons', 'valid-expiry').state, 'claimed');
});

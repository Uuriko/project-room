import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createRoomServer } from '../server/http.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { operatorWakeIndex } from '../server/operator-wake-index.mjs';
import { WAKE_INDEXES, boundedWakeDeliveryActive, compareWakePosition } from '../server/wake-delivery-window.mjs';
const operatorToken = 'local-wake-operator'.repeat(3);
async function fixture(t, count = 256) {
  const prior = process.env.ROOM_OPERATOR_TOKEN_SHA256;
  process.env.ROOM_OPERATOR_TOKEN_SHA256 = createHash('sha256').update(operatorToken).digest('hex');
  const store = new RoomStore(':memory:', { now: () => 2000000 }); store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner'), identity = store.identities.create('Synthetic delivery');
  linkWithProof(store, owner, 'commons', identity, { memberId: 'worker', displayName: 'Worker', permissions: ['accept_work'] });
  store.agentHeartbeats.heartbeat({ agentId: identity.identityId, hostId: 'host', mode: 'pull-only', workWakes: true });
  store.command(owner, 'commons', { id: 'proposal', type: 'work.proposed', data: { workItemId: 'task', title: 'Synthetic task', definitionOfDone: 'Synthetic acceptance', mode: 'read', accountableMemberId: 'worker' } });
  const row = store.db.prepare('SELECT * FROM agent_work_wakes WHERE agent_id=?').get(identity.identityId);
  store.transaction(() => {
    const insert = store.db.prepare('INSERT INTO agent_work_wakes VALUES(?,?,?,?,?,?,?,?,?,?,NULL,NULL)');
    for (let n = 0; n < count; n++) insert.run('ww_stale' + String(n).padStart(5, '0'), identity.identityId, 'commons', 'worker', 'task', -1, 'old-' + n, 'owner', row.pointer, 100);
    store.db.prepare('UPDATE agent_work_wakes SET created_at=200 WHERE signal_id=?').run(row.signal_id);
  });
  const server = createRoomServer({ store }); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); store.close();
    if (prior === undefined) delete process.env.ROOM_OPERATOR_TOKEN_SHA256; else process.env.ROOM_OPERATOR_TOKEN_SHA256 = prior; });
  const install = () => { const plan = operatorWakeIndex(store, { reason: 'Synthetic qualification' }); return operatorWakeIndex(store, { reason: 'Synthetic qualification', requestId: 'install', planHash: plan.planHash }, true); };
  return { store, identity, row, origin, install };
}
test('merged source horizons preserve interleaved messages and useful work through filtered windows', async t => {
  const f = await fixture(t);
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO agent_wake_signals VALUES(?,?,'mention','commons',?,?,NULL)");
    for (const [id, at] of [['message-before', 50], ['message-equal', 100], ['message-after', 300]]) insert.run(id, f.identity.identityId, id, at);
  });
  const legacy = f.store.agentHeartbeats.pendingWakePage(f.identity.identityId, { hostId: 'host' }).signals;
  f.install(); let cursor = null; const observed = [];
  for (let n = 0; n < 20; n++) {
    const page = f.store.agentHeartbeats.pendingWakePage(f.identity.identityId, { hostId: 'host', cursor, limit: 1 });
    observed.push(...page.signals); if (!page.more) break;
    assert.notEqual(page.nextCursor, cursor); cursor = page.nextCursor;
  }
  assert.deepEqual(observed, legacy); assert.deepEqual([...observed].sort(compareWakePosition), observed);
  const repeated = f.store.agentHeartbeats.pendingWakePage(f.identity.identityId, { hostId: 'host' });
  assert.equal(repeated.signals[0].signalId, 'message-before', 'pagination did not ack or invalidate anything');
  assert.throws(() => f.store.agentHeartbeats.pendingWakePage(f.identity.identityId, { hostId: 'other', cursor }), { code: 'invalid_wake_cursor' });
});
test('real poll returns empty-more immediately with usable cursor and never calls it a timeout', async t => {
  const f = await fixture(t); f.install();
  const response = await fetch(f.origin + '/api/agent-wakes/poll?hostId=host&waitMs=50000', { headers: { authorization: 'Bearer ' + f.identity.secret } });
  assert.equal(response.status, 200); const first = await response.json();
  assert.deepEqual(first.pendingWakes, []); assert.equal(first.more, true); assert.equal(typeof first.nextCursor, 'string');
  assert.equal(first.waitedMs, 0); assert.equal(first.timedOut, false);
  let cursor = first.nextCursor; const signals = [];
  for (let n = 0; n < 5; n++) {
    const next = await fetch(f.origin + '/api/agent-wakes/poll?hostId=host&waitMs=0&cursor=' + encodeURIComponent(cursor), { headers: { authorization: 'Bearer ' + f.identity.secret } });
    assert.equal(next.status, 200); const page = await next.json(); signals.push(...page.pendingWakes);
    if (!page.more) break; assert.notEqual(page.nextCursor, cursor); cursor = page.nextCursor;
  }
  assert.deepEqual(signals.map(row => row.signalId), [f.row.signal_id]);
});
test('operator authentication and method gate precede installation, and partial pair gives typed read refusal', async t => {
  const f = await fixture(t, 0), path = f.origin + '/api/operator/wakes/ordered-indexes/plan';
  const body = JSON.stringify({ reason: 'Synthetic qualification' });
  const denied = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body }); assert.equal(denied.status, 404);
  const method = await fetch(path, { headers: { authorization: 'Operator ' + operatorToken } }); assert.equal(method.status, 405);
  assert.equal(boundedWakeDeliveryActive(f.store.db), false);
  const planned = await fetch(path, { method: 'POST', headers: { authorization: 'Operator ' + operatorToken, 'content-type': 'application/json' }, body });
  assert.equal(planned.status, 200); const plan = await planned.json();
  const execute = await fetch(f.origin + '/api/operator/wakes/ordered-indexes/execute', { method: 'POST', headers: { authorization: 'Operator ' + operatorToken, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'Synthetic qualification', requestId: 'install', planHash: plan.planHash }) });
  assert.equal(execute.status, 200); assert.equal(boundedWakeDeliveryActive(f.store.db), true);
  f.store.db.exec('DROP INDEX ' + WAKE_INDEXES[1].name);
  const failed = await fetch(f.origin + '/api/agent-wakes/poll?hostId=host&waitMs=0', { headers: { authorization: 'Bearer ' + f.identity.secret } });
  assert.equal(failed.status, 503); assert.equal(failed.headers.get('retry-after'), '30'); assert.equal((await failed.json()).error.code, 'storage_unavailable');
});
test('room-scoped delivery never advances through or reveals foreign-room wake positions', async t => {
  const f = await fixture(t, 0);
  f.store.transaction(() => {
    const insert = f.store.db.prepare("INSERT INTO agent_wake_signals VALUES(?,?,'mention','foreign-room',?,1,NULL)");
    for (let n = 0; n < 1000; n++) insert.run('foreign-position-' + n, f.identity.identityId, 'private-reference-' + n);
  });
  f.install();
  const page = f.store.agentHeartbeats.pendingWakePage(f.identity.identityId, { roomId: 'commons', hostId: 'host' });
  assert.deepEqual(page.signals.map(row => row.signalId), [f.row.signal_id]);
  assert.equal(page.more, false); assert.equal(page.nextCursor, null);
  const key = f.store.issueAccessKey('commons', 'worker');
  const heartbeat = await fetch(f.origin + '/api/agent-heartbeats', { method: 'POST', headers: { authorization: 'Bearer ' + key, origin: f.origin, 'content-type': 'application/json' }, body: JSON.stringify({ hostId: 'scoped-host', mode: 'pull-only', workWakes: true }) });
  assert.equal(heartbeat.status, 200); const beat = await heartbeat.json();
  assert.deepEqual(beat.pendingWakes.map(row => row.signalId), [f.row.signal_id]); assert.equal(beat.more, false); assert.equal(beat.nextCursor ?? null, null);
  const polled = await fetch(f.origin + '/api/agent-wakes/poll?hostId=scoped-host&waitMs=0', { headers: { authorization: 'Bearer ' + key } });
  assert.equal(polled.status, 200); const current = await polled.json();
  assert.deepEqual(current.pendingWakes.map(row => row.signalId), [f.row.signal_id]); assert.equal(current.more, false); assert.equal(current.nextCursor, null);
});

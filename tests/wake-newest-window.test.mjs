import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorWakeIndex } from '../server/operator-wake-index.mjs';
import { readWakeWindow, WAKE_WINDOW_LIMITS } from '../server/wake-delivery-window.mjs';
import { heartbeatWithListener } from '../server/agent-listener-contract.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
function fixture(t, install = true) {
  const store = new RoomStore(':memory:'); store.initialize(initialRoom()); t.after(() => store.close());
  if (install) { const reason = 'Synthetic newest discovery', plan = operatorWakeIndex(store, { reason }); operatorWakeIndex(store, { reason, planHash: plan.planHash, requestId: 'newest-install' }, true); }
  return store;
}
function seed(s, count, room = 'commons', at = 1) {
  s.transaction(() => { const insert = s.db.prepare("INSERT INTO agent_wake_signals VALUES(?,'agent','mention',?,?,?,NULL)");
    for (let n = 0; n < count; n++) insert.run(room + '-' + String(n).padStart(5, '0'), room, 'message-' + n, at); });
}
test('newest traverses equal-timestamp indexed input backward without gaps or acknowledgements', t => {
  const s = fixture(t); seed(s, 301); seed(s, 1000, 'foreign', 2);
  const ids = []; let after = null;
  do { const page = readWakeWindow(s.db, 'agent_wake_signals', 'agent', after, 'commons', 'newest');
    assert.ok(page.rows.length <= WAKE_WINDOW_LIMITS.rows); assert.ok(page.admitted.bytes <= WAKE_WINDOW_LIMITS.bytes);
    ids.push(...page.rows.map(row => row.signal_id)); after = page.more ? page.through : null;
  } while (after);
  assert.equal(ids.length, 301); assert.equal(new Set(ids).size, 301);
  assert.equal(ids[0], 'commons-00300'); assert.equal(ids.at(-1), 'commons-00000');
  assert.equal(s.db.prepare('SELECT count(*) n FROM agent_wake_signals WHERE delivered_at IS NOT NULL').get().n, 0);
});
test('newest page and cursor stay separate from oldest and foreign room or host scopes', t => {
  const s = fixture(t); seed(s, 150);
  const oldest = s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons', limit: 1 });
  const latest = s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons', limit: 1, order: 'newest' });
  assert.equal(latest.signals[0].signalId, 'commons-00149'); assert.equal(oldest.signals[0].signalId, 'commons-00000');
  assert.throws(() => s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons', cursor: latest.nextCursor }), { code: 'invalid_wake_cursor' });
  assert.throws(() => s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons', order: 'newest', cursor: oldest.nextCursor }), { code: 'invalid_wake_cursor' });
  for (const scope of [{roomId:'foreign'}, {roomId:'commons',hostId:'foreign'}]) assert.throws(() => s.agentHeartbeats.pendingWakePage('agent', { ...scope, order: 'newest', cursor: latest.nextCursor }), { code: 'invalid_wake_cursor' });
  assert.equal(s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons', order: 'newest', limit: 1, cursor: latest.nextCursor }).signals[0].signalId, 'commons-00148');
});
test('newest refuses missing activation and unselected scope rather than taking legacy reads', t => {
  const s = fixture(t, false); seed(s, 1);
  assert.throws(() => s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons', order: 'newest' }), { code: 'storage_unavailable' });
  assert.throws(() => s.agentHeartbeats.pendingWakePage('agent', { order: 'newest' }), { code: 'invalid_wake_poll' });
  assert.equal(s.agentHeartbeats.pendingWakePage('agent', { roomId: 'commons' }).signals.length, 1);
});
test('oversized newest field refuses before payload transfer, default oldest still serves its admitted window', t => {
  const s = fixture(t); seed(s, 300);
  s.transaction(() => s.db.prepare("UPDATE agent_wake_signals SET message_id=? WHERE signal_id='commons-00299'").run('x'.repeat(1025)));
  let payloadReads = 0; const prepare = s.db.prepare.bind(s.db);
  s.db.prepare = sql => { if (/WHERE rowid=\?/.test(sql)) payloadReads++; return prepare(sql); };
  assert.throws(() => readWakeWindow(s.db, 'agent_wake_signals', 'agent', null, 'commons', 'newest'), {code:'storage_unavailable'});
  assert.equal(payloadReads, 0); assert.equal(readWakeWindow(s.db, 'agent_wake_signals', 'agent', null, 'commons').rows.length, 128);
});
test('only acquired selected listener advertises installed newest capability without changing lease authority', t => {
  const s = fixture(t, false), identity = s.identities.create('Synthetic listener'), owner = s.issueAccessKey('commons','owner');
  linkWithProof(s, owner, 'commons', identity, { memberId:'worker', permissions:[] });
  const input = {hostId:'host',mode:'pull-only',listenerLease:{roomId:'commons'}}, auth = {identityId:identity.identityId};
  assert.equal(s.transaction(() => heartbeatWithListener(s,auth,input)).wakeSelection, undefined);
  const reason='Synthetic newest discovery', plan=operatorWakeIndex(s,{reason}); s.transaction(() => operatorWakeIndex(s,{reason,planHash:plan.planHash,requestId:'install'},true));
  const acquired = s.transaction(() => heartbeatWithListener(s,auth,input));
  assert.deepEqual(acquired.wakeSelection,{version:1,newest:true,roomId:'commons'});
  assert.equal(s.transaction(() => heartbeatWithListener(s,auth,{...input,hostId:'other'})).wakeSelection,undefined);
  assert.equal(s.transaction(() => heartbeatWithListener(s,auth,{hostId:'host',mode:'pull-only'})).wakeSelection,undefined);
});

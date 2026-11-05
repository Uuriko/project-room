import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { createRoomServer } from '../server/http.mjs';
import { linkWithProof } from './helpers/link-with-proof.mjs';
import { setTier } from '../server/autonomy-tiers.mjs';

test('private canonical work does not hide a preexisting unlinked native Board title with the same id', async t => {
  const f = createAcceptanceFixture(), server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  const identity = f.store.identities.create('Native Board holder');
  linkWithProof(f.store, f.keys.owner, 'commons', identity, { memberId: 'observer', displayName: 'Observer', permissions: ['accept_work', 'complete_work'] });
  setTier(f.store.db, 'commons', 'observer', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, data) => {
    const response = await fetch(origin + path, { method: data ? 'POST' : 'GET',
      headers: { Origin: origin, Authorization: `Bearer ${identity.secret}`, ...(data ? { 'Content-Type': 'application/json' } : {}) },
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const value = await response.json(); assert.ok(response.ok, JSON.stringify({ status: response.status, value })); return value;
  };
  await request('/api/rooms/commons/work-claims', { id: 'same-id', title: 'PUBLIC-NATIVE-TITLE-SENTINEL' });
  await request('/api/rooms/commons/work-claims/same-id/claim', {});
  const send = (actor, type, data) => f.store.command(f.keys[actor], 'commons', { id: crypto.randomUUID(), type, data });
  send('owner', 'work.proposed', { workItemId: 'same-id', title: 'PRIVATE-CANONICAL-TITLE-SENTINEL',
    definitionOfDone: 'Private definition', accountableMemberId: 'producer', independentVerificationRequired: false, ownerDecisionRequired: false });
  f.store.dmConsents.request('commons', 'owner', 'producer', 'Synthetic private brief');
  f.store.dmConsents.decide('commons', 'producer', 'owner', 'approve');
  send('owner', 'message.posted', { messageId: 'same-id-private-request', toMemberId: 'producer', workItemId: 'same-id', requestKind: 'reply', body: 'Private task context' });
  send('producer', 'work.accepted', { workItemId: 'same-id', expectedRevision: 0 });
  const before = f.store.workClaims.get('commons', 'same-id');
  assert.equal(before.owner, 'observer'); assert.equal(before.workItemId, null, 'real native Board row remains independent');
  const orientation = await request('/api/rooms/commons?view=orientation');
  assert.equal(orientation.state.workItems['same-id'].title, null);
  const context = await request('/api/rooms/commons/context');
  assert.equal(JSON.stringify(context).includes('PRIVATE-CANONICAL-TITLE-SENTINEL'), false);
  assert.equal(context.orient.claims.find(item => item.id === 'same-id').title, 'PUBLIC-NATIVE-TITLE-SENTINEL',
    'same id alone does not make native Board text a linked private definition');
  assert.deepEqual(f.store.workClaims.get('commons', 'same-id'), before);
});

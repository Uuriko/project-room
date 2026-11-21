import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorNormalization } from '../server/operator-normalization.mjs';
import { readBoard } from '../server/board-read.mjs';
import { closeWork } from '../server/work-claims.mjs';
import { event } from '../src/events.js';

test('retained normalized Board mirrors keep the canonical task visibility', t => {
  const store = new RoomStore(':memory:');
  t.after(() => store.close());
  const roomId = 'commons';
  const genesis = initialRoom();
  for (const memberId of ['worker', 'observer']) {
    genesis.push(event({ roomId, actorId: 'owner', type: 'member.added', data: {
      memberId, displayName: memberId, kind: 'agent', permissions: ['accept_work', 'complete_work'],
    } }));
  }
  store.initialize(genesis);
  const keys = Object.fromEntries(['owner', 'worker', 'observer'].map(id => [id, store.issueAccessKey(roomId, id)]));
  const send = (actor, id, type, data) => store.command(keys[actor], roomId, { id, type, data });
  store.dmConsents.request(roomId, 'owner', 'worker', 'Synthetic private brief');
  store.dmConsents.decide(roomId, 'worker', 'owner', 'approve');
  for (const [id, title] of [['private-work', 'Private Board title'], ['shared-work', 'Shared Board title']]) {
    send('owner', id + '-propose', 'work.proposed', { workItemId: id, title,
      definitionOfDone: 'Return the selected result', accountableMemberId: 'worker', independentVerificationRequired: false });
    if (id === 'private-work') send('owner', 'private-request', 'message.posted', {
      messageId: 'private-request', toMemberId: 'worker', workItemId: id, requestKind: 'reply', body: 'Private context',
    });
    send('worker', id + '-accept', 'work.accepted', { workItemId: id, expectedRevision: 0 });
    const mirror = store.workClaims.get(roomId, id);
    assert.ok(mirror);
    store.workClaims.set(roomId, closeWork(mirror, 'owner', { authority: true, reason: 'Retain synthetic mirror history' }));
  }
  const query = new URLSearchParams({ state: 'closed' });
  const rowFor = (actor, id) => readBoard(store, keys[actor], roomId, null, query).claims.find(row => row.id === id);
  const observerBefore = rowFor('observer', 'private-work');
  assert.equal(observerBefore.title, null);
  const args = { roomId, discardLegacyAssignments: false };
  const plan = operatorNormalization(store, args);
  operatorNormalization(store, { ...args, planHash: plan.planHash, reason: 'Privacy parity regression fixture', requestId: 'preserve-mirrors' }, true);
  assert.equal(rowFor('observer', 'private-work').title, null);
  assert.deepEqual(rowFor('observer', 'private-work').history, []);
  assert.equal(rowFor('observer', 'shared-work').title, 'Shared Board title');
  assert.equal(rowFor('worker', 'private-work').title, 'Private Board title');
  assert.equal(store.workClaims.get(roomId, 'private-work').title, 'Private Board title');
});

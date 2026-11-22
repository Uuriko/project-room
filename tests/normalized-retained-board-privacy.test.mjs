import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { operatorNormalization } from '../server/operator-normalization.mjs';
import { readBoard } from '../server/board-read.mjs';
import { attestWork, closeWork, createWork } from '../server/work-claims.mjs';
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
      definitionOfDone: 'Return the selected result', accountableMemberId: 'worker', mode: 'read', independentVerificationRequired: false });
    if (id === 'private-work') send('owner', 'private-request', 'message.posted', {
      messageId: 'private-request', toMemberId: 'worker', workItemId: id, requestKind: 'reply', body: 'Private context',
    });
    send('worker', id + '-accept', 'work.accepted', { workItemId: id, expectedRevision: 0 });
    send('worker', id + '-start', 'work.started', { workItemId: id, expectedRevision: 1 });
    const mirror = store.workClaims.get(roomId, id);
    assert.ok(mirror);
    store.workClaims.set(roomId, attestWork(mirror, 'owner', { note: 'Original Board review' }));
  }
  const historical = createWork({ id: 'historical', title: 'Historical Board title',
    workItemId: 'no-current-item' }, { agentId: 'owner' });
  store.workClaims.set(roomId, closeWork(historical, 'owner', { authority: true }));
  const query = new URLSearchParams();
  const rowFor = (actor, id) => readBoard(store, keys[actor], roomId, null, query).claims.find(row => row.id === id);
  const observerBefore = rowFor('observer', 'private-work');
  assert.equal(observerBefore.title, null);
  const args = { roomId, discardLegacyAssignments: false, retainMirroredLegacyClaims: true };
  assert.throws(() => operatorNormalization(store, { ...args, discardLegacyAssignments: true }),
    { code: 'invalid_normalization_request' });
  const plan = operatorNormalization(store, args);
  assert.equal(plan.retainedLegacyMirrors.count, 2);
  const original = store.workClaims.get(roomId, 'private-work');
  const request = { ...args, reason: 'Privacy parity regression fixture', requestId: 'preserve-mirrors' };
  store.workClaims.set(roomId, { ...original, owner: 'observer' });
  assert.throws(() => operatorNormalization(store, args), { code: 'current_room_legacy_work_unreconciled' });
  store.workClaims.set(roomId, { ...original, dependsOn: ['board-only-prerequisite'] });
  assert.throws(() => operatorNormalization(store, args), { code: 'current_room_legacy_work_unreconciled' });
  store.workClaims.set(roomId, attestWork(original, 'worker', { note: 'Additional Board review' }));
  assert.throws(() => operatorNormalization(store, { ...request, planHash: plan.planHash }, true), { code: 'plan_changed' });
  const updated = operatorNormalization(store, args);
  const exact = { ...request, planHash: updated.planHash };
  const retained = store.workClaims.get(roomId, 'private-work');
  const set = store.workClaims.set;
  store.workClaims.set = (...values) => {
    set(...values);
    throw Error('synthetic interruption after mirror write');
  };
  try {
    assert.throws(() => operatorNormalization(store, exact, true), /synthetic interruption/);
  } finally {
    store.workClaims.set = set;
  }
  assert.deepEqual(store.workClaims.get(roomId, 'private-work'), retained);
  const result = operatorNormalization(store, exact, true);
  assert.equal(result.retainedLegacyMirrors.count, 2);
  assert.deepEqual(result.legacyDiscarded, {});
  assert.equal(operatorNormalization(store, exact, true).duplicate, true);
  assert.equal(rowFor('observer', 'private-work').title, null);
  assert.deepEqual(rowFor('observer', 'private-work').history, []);
  assert.equal(rowFor('observer', 'shared-work').title, 'Shared Board title');
  assert.equal(rowFor('observer', 'historical').title, 'Historical Board title');
  assert.equal(rowFor('worker', 'private-work').title, 'Private Board title');
  assert.equal(store.workClaims.get(roomId, 'private-work').title, 'Private Board title');
  assert.deepEqual(store.workClaims.get(roomId, 'private-work').attestations, retained.attestations);
  assert.equal(store.workClaims.get(roomId, 'private-work').state, 'closed');
  assert.equal(store.workClaims.get(roomId, 'private-work').history.at(-1).agentId, 'system');
});

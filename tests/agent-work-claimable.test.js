// Owns the claim-blocker fields of server/routes/agent-work.mjs: blockedBy must
// name exactly the open requests a claim on request-runs would refuse.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { AgentRooms } from '../server/agent-rooms.mjs';
import { createRoomServer } from '../server/http.mjs';

async function scenario(t, mutate) {
  const store = new RoomStore(':memory:'), rooms = new AgentRooms(store);
  const owner = store.identities.create('Owen'), worker = store.identities.create('Worker'), other = store.identities.create('Riley');
  rooms.create(owner.secret, { roomId: 'commons', title: 'Work view', purpose: 'Test', kind: 'personal' });
  for (const identity of [worker, other]) {
    store.identities.link(owner.secret, 'commons', { identityId: identity.identityId, displayName: identity === worker ? 'Worker' : 'Riley', permissions: [] });
    store.dmConsents.request('commons', owner.identityId, identity.identityId, 'Fixture');
    store.dmConsents.decide('commons', identity.identityId, owner.identityId, 'approve');
  }
  const ask = (from, id) => store.command(from.secret, 'commons', { id, type: 'message.posted', data: { messageId: id, toMemberId: worker.identityId, requestKind: 'reply', body: 'q' } });
  ask(owner, 'q-owner'); ask(other, 'q-other');
  mutate?.({ store, owner, worker, other });
  const sequenceBeforeRead = store.room('commons').sequence;
  const server = createRoomServer({ store });
  t.after(async () => { server.closeStreams(); server.closeAllConnections(); if (server.listening) await new Promise(r => server.close(r)); store.close(); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/rooms/commons/agent-work`, { headers: { Authorization: `Bearer ${worker.secret}` } });
  assert.equal(response.status, 200);
  const view = await response.json();
  assert.equal(store.room('commons').sequence, sequenceBeforeRead, 'the read wrote nothing');
  assert.equal(view.evaluatedThrough, sequenceBeforeRead);
  const refused = {};
  for (const request of view.requests) {
    try {
      store.requestRuns.apply(worker.secret, 'commons', { requestMessageId: request.id, attemptId: 'a-' + request.id, action: 'claim',
        expectedRequestRevision: request.revision, contextEventId: request.contextEventId });
    } catch (error) { refused[request.id] = error.code; }
  }
  return { view, refused };
}

const cases = {
  baseline: [null, {}],
  'agent paused itself': [({ store, worker }) => store.wakeQueue.pause(worker.secret, 'commons', { requestId: 'pause-1', reason: null }),
    { 'q-owner': ['paused'], 'q-other': ['paused'] }],
  'room archived': [({ store, owner }) => store.command(owner.secret, 'commons', { id: 'arch-1', type: 'room.archived', data: {} }),
    { 'q-owner': ['room_archived'], 'q-other': ['room_archived'] }],
  'requester blocks the agent': [({ store, worker, other }) => store.dmConsents.block('commons', other.identityId, worker.identityId),
    { 'q-other': ['dm_blocked'] }],
  'requester removed': [({ store, owner, other }) => store.identities.unlink(owner.secret, 'commons', other.identityId),
    { 'q-other': ['requester_inactive'] }],
};
for (const [name, [mutate, expected]] of Object.entries(cases)) {
  test(`agent work blockedBy matches the claim path: ${name}`, async t => {
    const { view, refused } = await scenario(t, mutate);
    assert.deepEqual(view.requests.map(request => request.id).sort(), ['q-other', 'q-owner']);
    assert.deepEqual(view.blockedBy, expected);
    assert.deepEqual(Object.keys(refused).sort(), Object.keys(view.blockedBy).sort(), 'blocked exactly where the claim refuses');
    assert.equal(view.archivedAt !== null, name === 'room archived');
    assert.equal(view.paused?.heldBy ?? null, name === 'agent paused itself' ? 'self' : null);
    assert.equal(view.executionGranted, false);
  });
}

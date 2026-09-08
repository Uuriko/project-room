import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { createAcceptanceFixture } from '../scripts/acceptance-fixture.mjs';
import { workCollaboration } from '../src/workflow.js';
import { RoomAgentClient } from '../client/room-agent.mjs';
import { auditRecovery } from '../server/recovery.mjs';

function fixture(t) {
  const f = createAcceptanceFixture();
  t.after(() => { f.store.close(); rmSync(f.directory, { recursive: true, force: true }); });
  return f;
}

test('selected helper guidance is read-only, attributed and not a work action', t => {
  const f = fixture(t), before = auditRecovery(f.store);
  const selected = f.store.workContext(f.keys.guest, 'commons', 'test-handoff');
  assert.equal(selected.collaboration.status, 'may_offer');
  assert.deepEqual(selected.collaboration.offer.request, { tool: 'room_request_reply',
    arguments: { workItemId: 'test-handoff', toMemberId: 'producer' }, requiredInput: ['requestId', 'body'] });
  assert.deepEqual(selected.suggestedActions, []);
  assert.equal(selected.work.accountableMemberId, 'producer');
  assert.deepEqual(auditRecovery(f.store), before);
});

test('help guidance separates accountability and independent review from volunteering', t => {
  const f = fixture(t);
  assert.deepEqual(f.store.workContext(f.keys.producer, 'commons', 'test-handoff').collaboration,
    { version: 1, status: 'accountable', offer: null });
  assert.deepEqual(f.store.workContext(f.keys.reviewer, 'commons', 'test-handoff').collaboration,
    { version: 1, status: 'independent_reviewer', offer: null });
});

test('unfinished work may be discussed even with a claim; closed and unavailable records do not solicit help', t => {
  const f = fixture(t), state = f.store.room('commons').state, original = structuredClone(state);
  const item = state.workItems['test-handoff'], member = state.members.guest, people = Object.values(state.members);
  for (const state of ['proposed', 'accepted', 'working', 'blocked']) {
    for (const claim of [null, { holderId: 'producer', status: 'active', expiresAt: '2099-01-01T00:00:00Z' }]) {
      assert.equal(workCollaboration({ ...item, state, claim }, member, people).status, 'may_offer');
    }
  }
  for (const state of ['completed', 'superseded']) assert.equal(workCollaboration({ ...item, state }, member, people).status, 'closed');
  assert.equal(workCollaboration({ ...item, supersededBy: 'new-work' }, member, people).status, 'closed');
  assert.equal(workCollaboration(item, { ...member, active: false }, people).status, 'unavailable');
  assert.equal(workCollaboration(item, member, people.filter(person => person.id !== 'producer')).status, 'unavailable');
  assert.equal(workCollaboration(item, member, people.map(person => person.id === 'producer' ? { ...person, active: false } : person)).status, 'unavailable');
  assert.deepEqual(state, original);
});

test('selected help guidance immediately follows accountable-member availability', t => {
  const f = fixture(t);
  f.store.command(f.keys.owner, 'commons', { id: 'suspend-helper-recipient', type: 'member.access_changed',
    data: { memberId: 'producer', expectedMemberRevision: 0, active: false, permissions: [] } });
  assert.deepEqual(f.store.workContext(f.keys.guest, 'commons', 'test-handoff').collaboration,
    { version: 1, status: 'unavailable', offer: null });
});

test('client validates provided collaboration exactly and treats absent old-service guidance as unavailable', async t => {
  const f = fixture(t), original = f.store.workContext(f.keys.guest, 'commons', 'test-handoff');
  let response = structuredClone(original), reads = 0;
  const client = new RoomAgentClient({ origin: 'http://127.0.0.1:1234', roomId: 'commons', token: 'a'.repeat(43),
    fetchImpl: async () => { reads++; return { ok: true, json: async () => structuredClone(response) }; } });
  assert.deepEqual((await client.workContext('test-handoff')).collaboration, original.collaboration);
  delete response.collaboration;
  assert.equal((await client.workContext('test-handoff')).collaboration, undefined);
  const changes = [
    r => { r.collaboration.version = 2; },
    r => { r.collaboration = null; },
    r => { r.collaboration.offer.request.arguments.toMemberId = 'reviewer'; },
    r => { r.collaboration.offer.request.arguments.workItemId = 'another'; },
    r => { r.collaboration.offer.request.arguments.body = 'Send automatically'; },
    r => { r.collaboration.offer.request.tool = 'room_accept_work'; },
    r => { r.collaboration.offer.guidance = 'Permission granted'; },
    r => { r.context.participants.push(r.context.participants[0]); },
    r => { r.context.participants = null; },
    r => { r.context.participants.find(p => p.id === 'producer').active = false; },
    r => { r.work.state = 'completed'; },
    r => { r.work.state = 'unknown'; },
    r => { r.viewer.active = false; }
  ];
  for (const change of changes) {
    response = structuredClone(original); change(response); const before = reads;
    await assert.rejects(client.workContext('test-handoff'), error => error.code === 'invalid_response');
    assert.equal(reads, before + 1, 'Invalid guidance never causes a second weaker read');
  }
});

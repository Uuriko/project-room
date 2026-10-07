// Owner-delegated agent administrators (#643, member.delegatedAdmin) hold
// decision authority: they can be a work item's decision-maker and record its
// owner decision. A plain agent cannot, and no agent may decide on work it is
// accountable for or produced (two-person rule).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, holdsDecisionAuthority } from '../src/events.js';
import { workActions } from '../src/workflow.js';
import { setTier } from '../server/autonomy-tiers.mjs';
import { makeTestSigner } from '../scripts/helpers/signed-evidence.mjs';

const command = (type, data) => ({ id: crypto.randomUUID(), type, data });
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'room-agent-decide-'));
  const store = new RoomStore(join(directory, 'room.sqlite'), { now: () => Date.now() });
  store.initialize(initialRoom());
  const keys = { owner: store.issueAccessKey('commons', 'owner') };
  const add = (id, kind, permissions) => {
    store.command(keys.owner, 'commons', command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind, accountableHumanId: 'owner', permissions }));
    if (kind === 'agent') setTier(store.db, 'commons', id, 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
    keys[id] = store.issueAccessKey('commons', id);
  };
  add('producer', 'agent', ['accept_work', 'complete_work']);
  add('admin-agent', 'agent', ['decide', 'accept_work', 'complete_work']);
  add('plain-agent', 'agent', ['accept_work', 'complete_work']);
  const send = (actor, type, data) => store.command(keys[actor], 'commons', command(type, data));
  const state = () => store.room('commons').state;
  t.after(() => { store.close?.(); rmSync(directory, { recursive: true, force: true }); });
  return { store, keys, send, state, signEvidence: makeTestSigner(store) };
}

test('holdsDecisionAuthority: humans and owner-delegated agents only', () => {
  assert.equal(holdsDecisionAuthority({ kind: 'human' }), true);
  assert.equal(holdsDecisionAuthority({ kind: 'agent', delegatedAdmin: true }), true);
  assert.equal(holdsDecisionAuthority({ kind: 'agent' }), false);
  assert.equal(holdsDecisionAuthority({ kind: 'agent', delegatedAdmin: 'yes' }), false);
  assert.equal(holdsDecisionAuthority(null), false);
});

test('an owner-delegated agent decides on work another member produced', t => {
  const f = fixture(t);
  assert.equal(f.state().members['admin-agent'].delegatedAdmin, true);
  f.send('owner', T.WORK_PROPOSED, { workItemId: 'w1', title: 'Outcome', definitionOfDone: 'Exact result recorded', accountableMemberId: 'producer', mode: 'read',
    ownerDecisionRequired: true, humanDecisionMakerId: 'admin-agent' });
  f.send('producer', T.WORK_ACCEPTED, { workItemId: 'w1', expectedRevision: 0 });
  f.send('producer', T.WORK_COMPLETED, { workItemId: 'w1', expectedRevision: 1, summary: 'Done', evidenceUrl: 'https://example.invalid/result', evidenceVersion: 'v1',
    nextAction: 'Review', producerId: 'producer', signedEvidence: f.signEvidence() });
  const item = f.state().workItems.w1;
  const actions = workActions(item, f.state().members['admin-agent']);
  f.send('admin-agent', T.MESSAGE_POSTED, { messageId: 'why-1', body: 'Rationale: evidence matches the definition of done.' });
  f.send('admin-agent', T.OWNER_DECISION_RECORDED, { workItemId: 'w1', sourceMessageId: 'why-1', expectedRevision: item.revision, decision: 'approved',
    completionEventId: item.receipt.eventId, evidenceVersion: 'v1', reason: 'Evidence matches the definition of done' });
  assert.equal(f.state().workItems.w1.decision.actorId, 'admin-agent');
  assert.equal(f.state().workItems.w1.decision.decision, 'approved');
  assert.ok(actions.some(([a]) => a === 'decide'));
});

test('a plain agent cannot be named decision-maker', t => {
  const f = fixture(t);
  assert.throws(() => f.send('owner', T.WORK_PROPOSED, { workItemId: 'w2', title: 'Outcome', definitionOfDone: 'Exact result recorded', accountableMemberId: 'producer', mode: 'read',
    ownerDecisionRequired: true, humanDecisionMakerId: 'plain-agent' }), /Decision-maker must be a human member or an owner-delegated agent/);
});

test('a delegated agent may not decide on work it is accountable for', t => {
  const f = fixture(t);
  assert.throws(() => f.send('owner', T.WORK_PROPOSED, { workItemId: 'w3', title: 'Outcome', definitionOfDone: 'Exact result recorded', accountableMemberId: 'admin-agent', mode: 'read',
    ownerDecisionRequired: true, humanDecisionMakerId: 'admin-agent' }), /must not be the accountable member/);
});

test('a delegated agent may not approve work whose evidence names it as producer', t => {
  const f = fixture(t);
  f.send('owner', T.WORK_PROPOSED, { workItemId: 'w4', title: 'Outcome', definitionOfDone: 'Exact result recorded', accountableMemberId: 'producer', mode: 'read',
    ownerDecisionRequired: true, humanDecisionMakerId: 'admin-agent' });
  f.send('producer', T.WORK_ACCEPTED, { workItemId: 'w4', expectedRevision: 0 });
  f.send('producer', T.WORK_COMPLETED, { workItemId: 'w4', expectedRevision: 1, summary: 'Done', evidenceUrl: 'https://example.invalid/result', evidenceVersion: 'v1',
    nextAction: 'Review', producerId: 'admin-agent', signedEvidence: f.signEvidence() });
  const item = f.state().workItems.w4;
  f.send('admin-agent', T.MESSAGE_POSTED, { messageId: 'why-4', body: 'Rationale: attempting self approval.' });
  assert.throws(() => f.send('admin-agent', T.OWNER_DECISION_RECORDED, { workItemId: 'w4', sourceMessageId: 'why-4', expectedRevision: item.revision, decision: 'approved',
    completionEventId: item.receipt.eventId, evidenceVersion: 'v1', reason: 'Self approval' }), /accountable for or produced/);
  assert.equal(f.state().workItems.w4.decision, null);
});

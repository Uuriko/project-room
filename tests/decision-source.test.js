// F2: owner decisions must cite the public room message carrying the rationale.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { EVENT_TYPES as T, applyEvent, event } from '../src/events.js';
import { makeTestSigner } from "../scripts/helpers/signed-evidence.mjs";
import { setTier } from "../server/autonomy-tiers.mjs";

const command = (type, data, id = crypto.randomUUID()) => ({ id, type, data });

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'project-room-decisionsrc-'));
  const store = new RoomStore(join(directory, 'room.sqlite'));
  store.initialize(initialRoom());
  const owner = store.issueAccessKey('commons', 'owner');
  for (const [id, kind] of [['human', 'human'], ['agent', 'agent']]) {
    store.command(owner, 'commons', command(T.MEMBER_ADDED, { memberId: id, displayName: id, kind, permissions: ['accept_work', 'complete_work', 'verify'] }));
  }
  // #953: new agent members default to t1_readonly; the agent fixture needs write access
  setTier(store.db, 'commons', 'agent', 't2_standard', { updatedBy: 'owner', nowMs: Date.now() });
  const human = store.issueAccessKey('commons', 'human');
  const agent = store.issueAccessKey('commons', 'agent');
  const signEvidence = makeTestSigner(store);
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, owner, human, agent, signEvidence };
}

// Drives a work item to the decision gate and returns the completion evidence.
function readyForDecision(f, workItemId) {
  const { store, owner, human, agent, signEvidence } = f;
  store.command(owner, 'commons', command(T.WORK_PROPOSED, { workItemId, title: `title-${workItemId}`, definitionOfDone: 'done',
    accountableMemberId: 'human', verifierMemberId: 'agent', independentVerificationRequired: true,
    ownerDecisionRequired: true, humanDecisionMakerId: 'owner' }));
  store.command(human, 'commons', command(T.WORK_ACCEPTED, { workItemId, expectedRevision: 0 }));
  store.command(human, 'commons', command(T.WORK_STARTED, { workItemId, expectedRevision: 1 }));
  const done = store.command(human, 'commons', command(T.WORK_COMPLETED, { workItemId, expectedRevision: 2,
    producerId: 'human', summary: 's', evidenceUrl: 'https://example.com/e', evidenceVersion: 'v1',
    nextAction: 'verify', signedEvidence: signEvidence() }));
  store.command(agent, 'commons', command(T.VERIFICATION_RECORDED, { workItemId, expectedRevision: 3,
    result: 'pass', completionEventId: done.event.id, evidenceVersion: 'v1', summary: 'checked' }));
  return { completionEventId: done.event.id, evidenceVersion: 'v1' };
}

const decide = (f, workItemId, evidence, extra = {}) => f.store.command(f.owner, 'commons',
  command(T.OWNER_DECISION_RECORDED, { workItemId, expectedRevision: 4, decision: 'approved',
    completionEventId: evidence.completionEventId, evidenceVersion: evidence.evidenceVersion,
    reason: 'good', ...extra }));

test('a decision without a source message is refused at the command boundary', t => {
  const f = fixture(t);
  const evidence = readyForDecision(f, 'w1');
  try {
    decide(f, 'w1', evidence);
    assert.fail('expected decision_source_required');
  } catch (error) {
    assert.equal(error.code, 'decision_source_required');
    assert.match(error.message, /post the rationale in the room first/i);
  }
});

test('a decision citing a public room message records with its source', t => {
  const f = fixture(t);
  const evidence = readyForDecision(f, 'w2');
  f.store.command(f.owner, 'commons', command(T.MESSAGE_POSTED, { messageId: 'rationale-w2', body: 'Rationale: v1 is solid.' }));
  decide(f, 'w2', evidence, { sourceMessageId: 'rationale-w2' });
  const decision = f.store.snapshot(f.owner, 'commons').state.workItems.w2.decision;
  assert.equal(decision.decision, 'approved');
  assert.equal(decision.sourceMessageId, 'rationale-w2');
});

test('a decision citing a missing message is rejected', t => {
  const f = fixture(t);
  const evidence = readyForDecision(f, 'w3');
  assert.throws(() => decide(f, 'w3', evidence, { sourceMessageId: 'no-such-message' }),
    /post the rationale in the room first/i);
});

test('a decision citing a deleted message is rejected', t => {
  const f = fixture(t);
  const evidence = readyForDecision(f, 'w4');
  f.store.command(f.owner, 'commons', command(T.MESSAGE_POSTED, { messageId: 'rationale-w4', body: 'Rationale, then removed.' }));
  f.store.command(f.owner, 'commons', command(T.MESSAGE_DELETED, { messageId: 'rationale-w4', expectedMessageRevision: 0, reason: 'oops' }));
  assert.throws(() => decide(f, 'w4', evidence, { sourceMessageId: 'rationale-w4' }),
    /post the rationale in the room first/i);
});

test('a decision citing a DM is rejected — the source must be public', t => {
  const f = fixture(t);
  const evidence = readyForDecision(f, 'w5');
  // The reducer rule, exercised directly: a DM can never serve as the public
  // rationale, even one the decision-maker could read.
  const state = structuredClone(f.store.snapshot(f.owner, 'commons').state);
  state.messages.push({ id: 'dm-rationale-w5', authorId: 'owner', body: 'Private rationale.',
    channelId: 'general', workItemId: null, replyToId: null, toMemberId: 'human', createdAt: new Date().toISOString() });
  const incoming = event({ actorId: 'owner', roomId: 'commons', type: T.OWNER_DECISION_RECORDED, data: {
    workItemId: 'w5', expectedRevision: 4, decision: 'approved',
    completionEventId: evidence.completionEventId, evidenceVersion: evidence.evidenceVersion,
    reason: 'good', sourceMessageId: 'dm-rationale-w5',
  } });
  assert.throws(() => applyEvent(state, incoming), /must be a public room message/i);
});

test('pre-requirement decision events without a source still replay', t => {
  // Legacy compatibility: RoomStore.rebuildProjection replays historical
  // events through the current reducer; an old OWNER_DECISION_RECORDED
  // carries no sourceMessageId and must apply cleanly.
  const { store, owner, human, agent, signEvidence } = fixture(t);
  const f = { store, owner, human, agent, signEvidence };
  const evidence = readyForDecision(f, 'w6');
  const state = store.snapshot(owner, 'commons').state;
  const legacy = event({ actorId: 'owner', roomId: 'commons', type: T.OWNER_DECISION_RECORDED, data: {
    workItemId: 'w6', expectedRevision: 4, decision: 'approved',
    completionEventId: evidence.completionEventId, evidenceVersion: evidence.evidenceVersion, reason: 'legacy approval',
  } });
  const next = applyEvent(structuredClone(state), legacy);
  assert.equal(next.workItems.w6.decision.decision, 'approved');
  assert.equal(next.workItems.w6.decision.sourceMessageId, undefined);
});

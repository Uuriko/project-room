import test from 'node:test';
import assert from 'node:assert/strict';
import { interactionSnapshot, reduceInteraction, validateInteraction } from '../client/evolution/interaction-contract.mjs';
const scope = { origin: 'https://room.example', roomId: 'room', roomCreatedEventId: 'birth', viewerId: 'human', authorizationRevision: 'auth:1' };
const attempt = { operationId: 'operation', attemptId: 'attempt-1', packageHash: 'a'.repeat(64) };
const item = { version: 1, id: 'question-1', scope, attempt, source: { id: 'request-1', revision: 1 }, kind: 'question', state: 'open',
  payload: { requestMessageId: 'request-1', recipientId: 'human', prompt: 'Choose a target', expiresAt: 2000000000000, operationDigest: null } };
const snapshot = () => interactionSnapshot({ scope, attempt, complete: true, watermark: 10, items: [item] });
test('partial snapshots never erase questions or advance a cursor', () => {
  assert.throws(() => interactionSnapshot({ scope, attempt, complete: false, watermark: 100, items: [] }), /incomplete/);
});
test('live and replay converge; duplicate delivery is a no-op', () => {
  const answered = { ...item, state: 'answered', source: { ...item.source, revision: 2 } };
  const live = reduceInteraction(snapshot(), { sequence: 11, item: answered });
  assert.equal(reduceInteraction(live, { sequence: 11, item: answered }), live);
  assert.deepEqual(live, interactionSnapshot({ scope, attempt, complete: true, watermark: 11, items: [answered] }));
  assert.equal(reduceInteraction(live, { sequence: 12, item }).items[0].state, 'answered');
});
test('stale attempt, room recreation, viewer switch and revoked authorization fail closed', () => {
  for (const changed of [ { ...item, attempt: { ...attempt, attemptId: 'old' } },
    ...['roomCreatedEventId', 'viewerId', 'authorizationRevision'].map(key => ({ ...item, scope: { ...scope, [key]: 'other' } })) ]) {
    assert.throws(() => reduceInteraction(snapshot(), { sequence: 11, item: changed }), /binding_mismatch/);
  }
});
test('source revision conflict and source identity replacement are refused', () => {
  assert.throws(() => reduceInteraction(snapshot(), { sequence: 11, item: { ...item, state: 'answered' } }), /revision_conflict/);
  assert.throws(() => reduceInteraction(snapshot(), { sequence: 11, item: { ...item, source: { id: 'different', revision: 2 } } }), /source_changed/);
});
test('questions cannot become approval by a label; approvals require exact operation digest', () => {
  assert.throws(() => validateInteraction({ ...item, kind: 'approval' }), /approval_binding/);
  assert.throws(() => validateInteraction({ ...item, payload: { ...item.payload, operationDigest: 'b'.repeat(64) } }), /approval_binding/);
  assert.equal(validateInteraction({ ...item, kind: 'approval', payload: { ...item.payload, operationDigest: 'b'.repeat(64) } }).kind, 'approval');
});
test('unknown fields and duplicate identities are refused; snapshots detach mutable inputs', () => {
  assert.throws(() => validateInteraction({ ...item, approved: true }), /invalid_interaction/);
  assert.throws(() => interactionSnapshot({ scope, attempt, complete: true, watermark: 10, items: [item, item] }), /duplicate/);
  const copy = snapshot(); copy.items[0].payload.prompt = 'changed'; assert.equal(item.payload.prompt, 'Choose a target');
});

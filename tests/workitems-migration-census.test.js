// Migration-shape census for decision #10 (workItems -> board claims),
// E6 characterization prep while the migration is gated on E1's
// AvailableWork projection. The flow behavior of work items is already
// covered by the command suites (acquisition-loops, agent-handoff,
// claim-scopes, board-projection, ...). This suite pins the one thing a
// data migration cannot afford to rediscover later: the EXACT field
// inventory of a maximally-populated work item and each sub-object, so a
// future field addition fails here until the migration mapping accounts
// for it. It also pins the migration's rollback foundation: the persisted
// projection reopens byte-identical after a restart.
// Real RoomStore + SQLite + production crypto; no test seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { makeTestSigner } from '../scripts/helpers/signed-evidence.mjs';

const keys = (obj) => Object.keys(obj).sort();

// A bare proposed item (propose-time shape, before any mutation adds keys).
// round_count / suspended_by / tool_calls are NOT in the creation literal:
// ensureWorkControlDefaults (src/work-item-session.js) backfills them onto
// every item on replay — a migration that copies only the creation shape
// silently drops the session counters.
const PROPOSED_ITEM_KEYS = [
  'accountableMemberId', 'blocker', 'claim', 'createdAt', 'decision', 'decisionHistory',
  'definitionOfDone', 'humanDecisionMakerId', 'id', 'independentVerificationRequired',
  'labels', 'mode', 'ownerDecisionRequired', 'proposedById', 'receipt', 'receiptHistory',
  'revision', 'round_count', 'sourceMessageId', 'state', 'supersededBy', 'suspended_by',
  'title', 'tool_calls', 'updatedAt',
  'verification', 'verificationHistory', 'verifierMemberId',
];
// Every key a work item can carry after claim + block + handoff +
// completion + verification + supersede have all touched it. Sub-objects
// that exist only conditionally in the wild (helpWanted via
// work.help_updated, handoffHistory after a second handoff, public-task
// linkage via work.public_set) are inventoried in the migration plan in
// exec-e6-work.md; this drive populates the claim-lifecycle core.
const POPULATED_ITEM_KEYS = [...PROPOSED_ITEM_KEYS, 'handoff'].sort();
const CLAIM_KEYS = [
  'acquiredAt', 'expiresAt', 'holderId', 'paths', 'ref', 'repository', 'status', 'supersededAt',
  // conditional in the wild: overlaps (cross-claim path overlap warning),
  // releasedAt, renewedAt, renewals, progressMessageId
];
const RECEIPT_KEYS = [
  'checksClaimed', 'eventId', 'evidenceUrl', 'evidenceVersion', 'nextAction',
  'producerAttribution', 'producerId', 'reportedById', 'segments', 'signedEvidence', 'summary',
];
const VERIFICATION_KEYS = [
  'completionEventId', 'eventId', 'evidenceVersion', 'independenceConfirmed', 'result', 'summary', 'verifierId',
];
const HANDOFF_KEYS = ['actorId', 'at', 'doneSummary', 'eventId', 'evidenceUrl', 'evidenceVersion', 'haltAll', 'limitReason', 'nextAction', 'open', 'triageMemberId'];
const BLOCKER_KEYS = ['eventId', 'nextAction', 'reason'];

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'workitems-census-'));
  const filename = join(dir, 'room.sqlite');
  let store = new RoomStore(filename);
  store.initialize(initialRoom());
  const ownerKey = store.issueAccessKey('commons', 'owner');
  store.command(ownerKey, 'commons', {
    id: 'add-worker', type: 'member.added',
    data: { memberId: 'worker', displayName: 'worker', kind: 'human', permissions: ['accept_work', 'complete_work', 'write_external'] },
  });
  const workerKey = store.issueAccessKey('commons', 'worker');
  t.after(() => { try { store.close(); } catch {} rmSync(dir, { recursive: true, force: true }); });
  const send = (key, id, type, data) => store.command(key, 'commons', { id, type, data });
  const item = (id) => store.room('commons').state.workItems[id];
  const mutate = (key, id, type, workItemId, data = {}) =>
    send(key, id, type, { workItemId, expectedRevision: item(workItemId).revision, ...data });
  return { get store() { return store; }, reopen: () => { store.close(); store = new RoomStore(filename); }, ownerKey, workerKey, send, item, mutate };
}

test('work item field census: every lifecycle sub-object shape is pinned', async (t) => {
  const f = fixture(t);
  const signEvidence = makeTestSigner(f.store);
  // Propose a fully-specified write-mode item.
  f.send(f.ownerKey, 'propose', 'work.proposed', {
    workItemId: 'census-1', title: 'Census item', definitionOfDone: 'All shapes recorded',
    accountableMemberId: 'worker', verifierMemberId: 'owner', labels: ['census'], mode: 'write',
  });
  assert.deepEqual(keys(f.item('census-1')), PROPOSED_ITEM_KEYS);
  assert.equal(f.item('census-1').state, 'proposed');

  f.mutate(f.workerKey, 'accept', 'work.accepted', 'census-1');
  assert.equal(f.item('census-1').state, 'accepted');

  // Claim: the scope reservation sub-object.
  const expiresAt = new Date(Date.now() + 2 * 3600e3).toISOString();
  f.mutate(f.workerKey, 'claim', 'claim.acquired', 'census-1', {
    repository: 'Uuriko/project-room', ref: 'main', paths: ['server/**'], expiresAt,
    pullRequests: ['https://github.com/Uuriko/project-room/pull/1'],
  });
  assert.deepEqual(keys(f.item('census-1').claim), CLAIM_KEYS.filter((k) => k !== 'supersededAt'));
  assert.equal(f.item('census-1').claim.status, 'active');

  f.mutate(f.workerKey, 'start', 'work.started', 'census-1');
  assert.equal(f.item('census-1').state, 'working');

  f.mutate(f.workerKey, 'block', 'work.blocked', 'census-1', { reason: 'waiting', nextAction: 'unblock soon' });
  assert.equal(f.item('census-1').state, 'blocked');
  assert.deepEqual(keys(f.item('census-1').blocker), BLOCKER_KEYS);

  // Census-worthy quirk: resolving a blocker returns the item to
  // ACCEPTED, not to the state it was blocked from.
  f.mutate(f.workerKey, 'resolve', 'work.blocker_resolved', 'census-1', { resolution: 'clear now' });
  assert.equal(f.item('census-1').state, 'accepted');
  assert.equal(f.item('census-1').blocker, null);

  f.mutate(f.workerKey, 'restart', 'work.started', 'census-1');
  f.mutate(f.workerKey, 'handoff', 'work.handoff_recorded', 'census-1', {
    doneSummary: 'Part done', evidenceUrl: 'https://example.com/evidence', evidenceVersion: 'v1',
    nextAction: 'Finish it', limitReason: 'time',
  });
  assert.deepEqual(keys(f.item('census-1').handoff), HANDOFF_KEYS);
  assert.equal(f.item('census-1').state, 'working'); // a handoff never advances state

  const text = 'Census delivery text';
  const evidenceVersion = `sha256:${createHash('sha256').update(text).digest('hex')}`;
  f.mutate(f.workerKey, 'complete', 'work.completed', 'census-1', {
    summary: text, evidenceVersion, producerId: 'worker',
    evidenceUrl: 'https://example.com/delivery', nextAction: 'Verify it', signedEvidence: signEvidence(),
  });
  assert.equal(f.item('census-1').state, 'completed');
  assert.deepEqual(keys(f.item('census-1').receipt), RECEIPT_KEYS);

  const receipt = f.item('census-1').receipt;
  f.mutate(f.ownerKey, 'verify', 'verification.recorded', 'census-1', {
    result: 'pass', completionEventId: receipt.eventId, evidenceVersion: receipt.evidenceVersion, summary: 'Checks out',
  });
  assert.deepEqual(keys(f.item('census-1').verification), VERIFICATION_KEYS);

  // Supersede the completed item; the claim is marked, not deleted.
  f.send(f.ownerKey, 'propose-2', 'work.proposed', {
    workItemId: 'census-2', title: 'Replacement', definitionOfDone: 'Replaces census-1',
    accountableMemberId: 'worker', mode: 'read',
  });
  f.mutate(f.ownerKey, 'supersede', 'work.superseded', 'census-1', { supersededByWorkItemId: 'census-2', reason: 'replanned' });
  const done = f.item('census-1');
  assert.equal(done.state, 'superseded');
  assert.equal(done.supersededBy, 'census-2');
  assert.equal(done.claim.status, 'superseded');
  assert.deepEqual(keys(done.claim), CLAIM_KEYS);
  assert.deepEqual(keys(done), POPULATED_ITEM_KEYS);
});

test('rollback foundation: the persisted projection reopens identical after restart', async (t) => {
  const f = fixture(t);
  f.send(f.ownerKey, 'propose', 'work.proposed', {
    workItemId: 'persist-1', title: 'Persisted', definitionOfDone: 'Survives restart',
    accountableMemberId: 'worker', mode: 'read',
  });
  f.mutate(f.workerKey, 'accept', 'work.accepted', 'persist-1');
  const before = JSON.parse(JSON.stringify(f.store.room('commons').state.workItems));
  f.reopen();
  assert.deepEqual(JSON.parse(JSON.stringify(f.store.room('commons').state.workItems)), before);
});

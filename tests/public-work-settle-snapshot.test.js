// FIX-SETTLE-SNAPSHOT: at settlement (a review decision, accept or
// reject) the claim record as it stood — lease fields, criteria set,
// verification facts — is frozen onto the receipt's own record as
// claimSnapshot. After settlement the live claim record is no longer
// reachable from any receipt surface: the task packet nulls
// leaseExpiresAt for receipted tasks, and round-ending lifecycle paths
// clear the lease fields on the item itself. The round-trip legs below
// settle, then clear the live record exactly that way, then show the
// snapshot on the canonical receipt read still carrying the
// as-at-settlement values.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { withPublicWorkClaimWriter } from '../server/public-work-claim-fence.mjs';

const REVIEWER = 'rev-snapshot-member';
const ARTIFACT = 'the delivered result bytes';

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const state = structuredClone(store.room('commons').state);
  state.members[REVIEWER] = { id: REVIEWER, revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const worker = store.identities.create('Snapshot worker');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'snapshot-task', reviewerMemberIds: ['owner', REVIEWER],
    terms: { kind: 'task', title: 'Snapshot task', summary: 'Freeze the claim at settlement', acceptanceCriteria: ['Correct result'],
      repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human_with_agent_review' } } });
  store.projectOffers.transition('commons', 'owner', 'snapshot-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'snapshot-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('snapshot-task', worker.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1, leaseHours: 6 });
  const receipt = store.publicWorkClaims.act('snapshot-task', worker.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: ARTIFACT, checksReported: ['unit: pass'] }).receipt;
  const input = (requestId, revision, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'Reviewed the exact artifact', ...extra });
  const stored = () => JSON.parse(store.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(receipt.receiptId).receipt_json);
  const liveItem = () => store.workClaims.get(receipt.namespaceId, receipt.taskId);
  t.after(() => store.close());
  return { store, reviews: new PublicWorkReviews(store), receipt, input, stored, liveItem };
}

test('no snapshot exists before a settlement decision', t => {
  const f = fixture(t);
  assert.equal(f.stored().claimSnapshot, undefined);
  // The evaporation surface is already live: the task packet nulls the
  // lease the moment a receipt exists, even though the registry item
  // still holds it.
  assert.equal(f.store.publicWorkClaims.read('snapshot-task').claim.leaseExpiresAt, null);
  assert.equal(typeof f.liveItem().leaseExpiresAt, 'string');
});

test('acceptance freezes the claim record as it stood at settlement, and it survives the live record being cleared', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  const before = f.liveItem();
  assert.equal(typeof before.leaseExpiresAt, 'string');
  f.reviews.verify('commons', REVIEWER, id, f.input('pass', 0, { verdict: 'PASS' }));
  f.reviews.decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const snapshot = f.stored().claimSnapshot;
  assert.equal(snapshot.schema, 'public-work-claim-snapshot/1');
  assert.equal(snapshot.taskId, 'snapshot-task');
  assert.equal(snapshot.receiptId, id);
  assert.equal(snapshot.generation, 1);
  assert.equal(snapshot.decision, 'accepted');
  assert.equal(snapshot.claim.owner, before.owner);
  assert.equal(snapshot.claim.claimedAt, before.claimedAt);
  assert.equal(snapshot.claim.leaseStartAt, before.leaseStartAt);
  assert.equal(snapshot.claim.leaseExpiresAt, before.leaseExpiresAt);
  assert.deepEqual(snapshot.criteria, ['Correct result']);
  assert.equal(snapshot.verification.verdict, 'PASS');
  assert.equal(snapshot.verification.tier, 'system_checked');
  assert.deepEqual(snapshot.verification.checksReported, ['unit: pass']);
  assert.equal(snapshot.verification.executedChecks.some(entry => entry.name === 'artifact_integrity' && entry.result === 'pass'), true);
  assert.equal(snapshot.delivery?.digest ?? null, before.delivery?.digest ?? null);
  // The round-trip: clear the live claim record the way production's
  // round-ending paths do (releaseWork/closeWork null the lease fields),
  // then re-read the receipt — the snapshot still carries the values.
  const cleared = { ...before, claimedAt: null, leaseStartAt: null, leaseExpiresAt: null };
  withPublicWorkClaimWriter(f.store, () => f.store.workClaims.set(f.receipt.namespaceId, cleared));
  assert.equal(f.liveItem().leaseExpiresAt, null);
  const reread = f.store.publicWorkClaims.receipt(id);
  assert.equal(reread.claimSnapshot.claim.leaseExpiresAt, before.leaseExpiresAt);
  assert.equal(reread.claimSnapshot.claim.claimedAt, before.claimedAt);
  assert.deepEqual(reread.claimSnapshot.criteria, ['Correct result']);
});

test('rejection is a settlement too: the snapshot freezes with the decision', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  const before = f.liveItem();
  f.reviews.verify('commons', REVIEWER, id, f.input('pass', 0, { verdict: 'PASS' }));
  f.reviews.decide('commons', 'owner', id, f.input('reject', 1, { decision: 'rejected' }));
  const snapshot = f.stored().claimSnapshot;
  assert.equal(snapshot.decision, 'rejected');
  assert.equal(snapshot.claim.leaseExpiresAt, before.leaseExpiresAt);
  assert.equal(snapshot.verification.verdict, 'PASS');
  const reread = f.store.publicWorkClaims.receipt(id);
  assert.equal(reread.state, 'rejected');
  assert.equal(reread.claimSnapshot.decision, 'rejected');
});

test('a revision request is not a settlement: no snapshot is written', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  f.reviews.decide('commons', 'owner', id, f.input('revise', 0, { decision: 'revision_requested' }));
  assert.equal(f.stored().claimSnapshot, undefined);
});

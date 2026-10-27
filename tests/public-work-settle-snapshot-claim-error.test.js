// REV-FIXES-1 (from REV-PRS-1 finding F-4297-1): stampClaimSnapshot's
// blanket catch used to bake a silent `claim: null` into the settlement
// snapshot when the claim read threw — indistinguishable, forever, from
// a genuinely absent claim, in the very record blind re-verification
// treats as ground truth. The snapshot now records `claimError` (the
// error's class) when capture failed, so failure and absence are
// permanently distinguishable. The happy path gains no field: its
// snapshot bytes are exactly the pre-change bytes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';

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
  t.after(() => store.close());
  return { store, reviews: new PublicWorkReviews(store), receipt, input, stored };
}

test('a claim read that throws at settlement stamps claimError, not a silent null', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  // Make exactly the snapshot's own claim read throw, the way a registry
  // fault or a future field-shape change would surface inside its
  // try/catch; every other read in the settlement flow keeps working.
  const original = f.store.workClaims.get.bind(f.store.workClaims);
  f.store.workClaims.get = (...args) => {
    if (new Error().stack.includes('stampClaimSnapshot')) throw new TypeError('registry read exploded');
    return original(...args);
  };
  f.reviews.verify('commons', REVIEWER, id, f.input('pass', 0, { verdict: 'PASS' }));
  // Settlement itself must still succeed — the marker records the
  // capture failure, it does not resurrect it as a settlement failure.
  f.reviews.decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const snapshot = f.stored().claimSnapshot;
  assert.equal(snapshot.decision, 'accepted');
  assert.equal(snapshot.claim, null);
  assert.equal(snapshot.delivery, null);
  assert.equal(snapshot.claimError, 'TypeError');
});

test('the happy path snapshot carries no claimError and its exact pre-change key shape', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  f.reviews.verify('commons', REVIEWER, id, f.input('pass', 0, { verdict: 'PASS' }));
  f.reviews.decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const snapshot = f.stored().claimSnapshot;
  assert.equal(Object.hasOwn(snapshot, 'claimError'), false);
  assert.deepEqual(Object.keys(snapshot),
    ['schema', 'taskId', 'receiptId', 'generation', 'termsVersion', 'settledAt', 'decision', 'claim', 'delivery', 'criteria', 'verification', 'settlement']);
  assert.equal(typeof snapshot.claim.leaseExpiresAt, 'string');
});

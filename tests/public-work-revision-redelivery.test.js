// UT2 conversion — REQUEST-CHANGES public-work leg (charter
// request-changes.md, Option A). `revision_requested` on an UNPAID task
// re-opens finish for the SAME claim/generation: the worker re-delivers,
// the new delivery is a new receipt, and the superseded receipt stays
// readable. A PAID task's `revision_requested` refuses, naming the bounty
// request-changes path and the successor path — paid work settles through
// its escrow bounty, never through a same-claim re-delivery.
//
// Fixtures use an in-memory store: this VM's write-fault episode makes
// on-disk SQLite opens fail environmentally (the file-backed review
// fixtures fail identically at base), and nothing here needs a reopen.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';

function unpaidFixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'revise-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'Revise this result', summary: 'Explicit feedback', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'revise-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'revise-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('revise-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('revise-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'first version', checksReported: ['Caller reports success'] }).receipt;
  t.after(() => { store.close(); });
  const input = (requestId, revision, receiptLike, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receiptLike.taskId,
    expectedTermsVersion: receiptLike.termsVersion, generation: receiptLike.generation, artifactSha256: receiptLike.artifact.sha256,
    reason: 'Reviewed the exact artifact', ...extra });
  return { store, producer, receipt, input, service: () => new PublicWorkReviews(store) };
}

function paidFixture(t) {
  let clock = Date.now();
  const store = new RoomStore(':memory:', { now: () => clock });
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.worker = { id: 'worker', revision: 1, kind: 'agent', active: true, displayName: 'Worker', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', producer.identityId, 'worker', clock);
  store.bountyEscrow.ensureGenesis('commons');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'paid-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'Paid public task', summary: 'Settle me', acceptanceCriteria: ['Correct result'],
      repositoryUrl: 'https://github.com/example/project', reward: { kind: 'work_trade', unit: 'credit', amountMinor: '4000' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'paid-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'paid-task',
    { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('paid-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('paid-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['checked'] }).receipt;
  t.after(() => { store.close(); });
  const input = (requestId, revision, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'Reviewed the exact artifact', ...extra });
  return { store, producer, receipt, input };
}

const code = expected => error => error.code === expected;

test('unpaid: revision_requested re-opens finish on the same claim/generation; both receipts stay readable', t => {
  const f = unpaidFixture(t), id = f.receipt.receiptId;
  // Before any revision request, a second finish is the existing refusal.
  assert.throws(() => f.store.publicWorkClaims.act('revise-task', f.producer.secret, 'finish',
    { requestId: 'finish-again', expectedTermsVersion: 1, generation: 1, artifactText: 'sneaky v2', checksReported: ['x'] }),
    code('public_work_already_submitted'));

  const decided = f.service().decide('commons', 'owner', id, f.input('revise', 0, f.receipt, { decision: 'revision_requested', reason: 'Fix the ending' }));
  assert.equal(decided.review.state, 'revision_requested');
  assert.equal(decided.review.rework?.reopensFinish, true);

  // Same claim, same generation: the worker re-delivers.
  const second = f.store.publicWorkClaims.act('revise-task', f.producer.secret, 'finish',
    { requestId: 'finish-v2', expectedTermsVersion: 1, generation: 1, artifactText: 'second version, ending fixed', checksReported: ['Caller reports success'] });
  assert.equal(second.action, 'submitted');
  assert.notEqual(second.receipt.receiptId, id);
  assert.equal(second.receipt.generation, 1);
  assert.equal(second.receipt.deliveryRound, 2);
  assert.equal(second.receipt.supersedesReceiptId, id);
  // The superseded delivery stays readable, still carrying its outcome.
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'revision_requested');
  assert.equal(f.store.publicWorkClaims.artifact(id).artifactText, 'first version');
  assert.equal(f.store.publicWorkClaims.receipt(second.receipt.receiptId).state, 'submitted');
  // The task packet points at the current (second) delivery.
  assert.equal(f.store.publicWorkClaims.read('revise-task').claim.submittedReceiptId, second.receipt.receiptId);
  // The new delivery is reviewable fresh and can be accepted.
  const accepted = f.service().decide('commons', 'owner', second.receipt.receiptId,
    f.input('accept-v2', 0, second.receipt, { decision: 'accepted' }));
  assert.equal(accepted.review.state, 'accepted');
  // And the re-delivery window is closed again after acceptance.
  assert.throws(() => f.store.publicWorkClaims.act('revise-task', f.producer.secret, 'finish',
    { requestId: 'finish-v3', expectedTermsVersion: 1, generation: 1, artifactText: 'third version', checksReported: ['x'] }),
    code('public_work_already_submitted'));
});

test('unpaid: the successor-task path still works after revision_requested', t => {
  const f = unpaidFixture(t), id = f.receipt.receiptId;
  const revised = f.service().decide('commons', 'owner', id, f.input('revise', 0, f.receipt, { decision: 'revision_requested', reason: 'Fix the ending' }));
  const terms = { kind: 'task', title: 'Follow-up task', summary: 'Take two', acceptanceCriteria: ['Correct result'],
    repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } };
  const out = f.store.publicWorkSuccessors.create('commons', 'owner', id, {
    requestId: 'follow-up', expectedReviewRevision: revised.review.revision, taskId: 'revise-task',
    expectedTermsVersion: 1, generation: 1, artifactSha256: f.receipt.artifact.sha256,
    successorTaskId: 'child-task', terms, repositoryRef: 'main', files: ['result.txt'],
  });
  assert.equal(out.followUp.taskId, 'child-task');
  assert.equal(out.followUp.available, true);
});

test('paid: revision_requested refuses, naming the bounty request-changes path and the successor path, and records no verdict', t => {
  const f = paidFixture(t), id = f.receipt.receiptId;
  let error = null;
  try {
    f.store.publicWorkReviews.decide('commons', 'owner', id, f.input('revise-paid', 0, { decision: 'revision_requested' }));
  } catch (caught) { error = caught; }
  assert.ok(error, 'paid revision_requested must refuse');
  assert.equal(error.code, 'revision_requested_paid_task');
  assert.match(error.message, /bounty request-changes path/);
  assert.match(error.message, /successor/);
  // No verdict recorded: the review is still pending at revision 0.
  const view = f.store.publicWorkReviews.inspect('commons', 'owner', id);
  assert.equal(view.review.state, 'pending');
  assert.equal(view.review.revision, 0);
  assert.equal(f.store.bountyEscrow.verifyConservation('commons').ok, true);
});

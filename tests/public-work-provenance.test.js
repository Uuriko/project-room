// #3612 (R-1/R-9) characterization: public-work receipts + reviews.
//
// Pins the provenance stamp on both consequential records of the
// public-work surface, following the bounty-rubrics pattern: the fields
// are asserted on the stored records (not just the responses), across a
// restart, and the fact/claim split is enforced — the session instance
// and the authorizing principal are server-derived (offer owner +
// claim round), while model/harness/environment are the submitter's or
// reviewer's pinned claims under claimed* names.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { sessionInstanceIdFor } from '../server/records-provenance.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-work-provenance-')), file = join(dir, 'room.sqlite');
  let store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'prov-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'Provenance task', summary: 'Stamped result', acceptanceCriteria: ['Correct result'],
      repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'prov-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'prov-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, producer,
    reopen() { store.close(); store = new RoomStore(file); } };
}
const code = expected => error => error.code === expected;

test('finish stamps the receipt: server-derived instance + offer-owner principal, claimed runtime pinned', t => {
  const f = fixture(t);
  f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const { receipt } = f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['unit: pass'],
      modelVersion: 'model-x/1.2', harnessVersion: 'room-harness/4', environment: 'node-24/linux' });
  const provenance = receipt.provenance;
  // (i) persistent identity was already on the receipt; (ii)+(iii) join it here.
  assert.equal(receipt.identityId, f.producer.identityId);
  assert.equal(provenance.authorizingPrincipalId, 'owner'); // the offer's owner_id, read from the stored offer row
  assert.equal(provenance.sessionInstanceId,
    sessionInstanceIdFor('public-work', [receipt.namespaceId, 'prov-task', 1, f.producer.identityId]));
  // R-9: the runtime report is pinned verbatim, under claimed* names.
  assert.equal(provenance.claimedModelVersion, 'model-x/1.2');
  assert.equal(provenance.claimedHarnessVersion, 'room-harness/4');
  assert.equal(provenance.claimedEnvironment, 'node-24/linux');
  // The stamp is on the STORED record and survives a restart, byte-identical.
  f.reopen();
  assert.deepEqual(f.store.publicWorkClaims.receipt(receipt.receiptId).provenance, provenance);
});

test('finish without a runtime report stamps facts with null claims — never a guessed default', t => {
  const f = fixture(t);
  f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const { receipt } = f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'quiet result', checksReported: [] });
  assert.equal(receipt.provenance.authorizingPrincipalId, 'owner');
  assert.match(receipt.provenance.sessionInstanceId, /^sess_[0-9a-f]{24}$/);
  assert.equal(receipt.provenance.claimedModelVersion, null);
  assert.equal(receipt.provenance.claimedHarnessVersion, null);
  assert.equal(receipt.provenance.claimedEnvironment, null);
});

test('a caller cannot forge the fact fields or smuggle an over-long claim onto the receipt', t => {
  const f = fixture(t);
  f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  // Fact-shaped fields are not accepted finish input at all.
  assert.throws(() => f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'finish',
    { requestId: 'forge', expectedTermsVersion: 1, generation: 1, artifactText: 'x', checksReported: [],
      sessionInstanceId: 'sess_forged', authorizingPrincipalId: 'mallory' }), code('invalid_public_work'));
  // A malformed claimed value fails the finish closed; no receipt is written.
  assert.throws(() => f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'finish',
    { requestId: 'bad-claim', expectedTermsVersion: 1, generation: 1, artifactText: 'x', checksReported: [],
      modelVersion: 'm'.repeat(201) }), code('invalid_public_work'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_receipts').get().n, 0);
});

test('decide stamps the review decision; the receipt verified successor keeps its pinned shape and the submission stamp is untouched', t => {
  const f = fixture(t);
  f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const { receipt } = f.store.publicWorkClaims.act('prov-task', f.producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: [], modelVersion: 'model-x/1.2' });
  const input = { requestId: 'accept', expectedReviewRevision: 0, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
    generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact',
    decision: 'accepted', modelVersion: 'review-tool/9' };
  const accepted = f.store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, input);
  const provenance = accepted.review.decision.provenance;
  assert.equal(provenance.authorizingPrincipalId, 'owner');
  assert.match(provenance.sessionInstanceId, /^sess_[0-9a-f]{24}$/);
  assert.notEqual(provenance.sessionInstanceId, receipt.provenance.sessionInstanceId); // the reviewer's instance, not the submitter's
  assert.equal(provenance.claimedModelVersion, 'review-tool/9'); // the reviewer's own claim, pinned on the verdict
  // The verified successor stamp keeps its pinned public shape (the
  // decision's provenance lives on the review record above); the
  // submission provenance is exactly as finish wrote it.
  const stamped = f.store.publicWorkClaims.receipt(receipt.receiptId);
  assert.equal(stamped.state, 'verified');
  assert.deepEqual(Object.keys(stamped.verified).sort(), ['at', 'by', 'passVerdict', 'reviewRevision']);
  assert.deepEqual(stamped.provenance, receipt.provenance);
  // Replay of the same decide returns the recorded outcome, stamp included.
  f.reopen();
  assert.deepEqual(f.store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, input), accepted);
});

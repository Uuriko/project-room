// FIX-SOURCE-POINTER: a public-work receipt records a resolvable source
// pointer at write time — the submitted artifact its verification claims
// are about (id + sha256 + the canonical artifact href) — and the public
// receipt read projects it, so an outsider can fetch the named source,
// hash it, and re-derive the claim. The resolution legs below execute
// the resolve; a pointer whose target no longer hashes to the recorded
// digest does not resolve, and a recorded pointer that contradicts the
// record's own artifact digest is never projected.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { publicReceiptById, queryPublicReceipts } from '../server/receipts-live.mjs';
import { receiptJson } from '../server/receipts-page.mjs';

const REVIEWER = 'rev-pointer-member';
const ARTIFACT = 'the delivered result bytes';
const sha256 = text => createHash('sha256').update(text, 'utf8').digest('hex');

function fixture(t) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const state = structuredClone(store.room('commons').state);
  state.members[REVIEWER] = { id: REVIEWER, revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const worker = store.identities.create('Pointer worker');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'pointer-task', reviewerMemberIds: ['owner', REVIEWER],
    terms: { kind: 'task', title: 'Pointer task', summary: 'Record the source', acceptanceCriteria: ['Correct result'],
      repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human_with_agent_review' } } });
  store.projectOffers.transition('commons', 'owner', 'pointer-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'pointer-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('pointer-task', worker.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('pointer-task', worker.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: ARTIFACT, checksReported: ['unit: pass'] }).receipt;
  const input = (requestId, revision, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'Reviewed the exact artifact', ...extra });
  const stored = () => JSON.parse(store.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(receipt.receiptId).receipt_json);
  t.after(() => store.close());
  return { store, reviews: new PublicWorkReviews(store), receipt, input, stored };
}

// The resolve an outsider performs: follow the pointer's href through
// the platform's own artifact read for the named receipt, hash what
// comes back, and compare against the pointer's recorded digest.
function resolvePointer(store, pointer) {
  assert.equal(pointer.href, `/api/public-work/receipts/${pointer.receiptId}/artifact`);
  const artifact = store.publicWorkClaims.artifact(pointer.receiptId);
  return sha256(artifact.artifactText) === pointer.sha256;
}

test('finish records the source pointer on the canonical receipt', t => {
  const f = fixture(t);
  const expected = { kind: 'artifact', receiptId: f.receipt.receiptId, sha256: sha256(ARTIFACT),
    href: `/api/public-work/receipts/${f.receipt.receiptId}/artifact` };
  assert.deepEqual(f.receipt.sourcePointer, expected);
  assert.deepEqual(f.stored().sourcePointer, expected);
  assert.equal(f.receipt.sourcePointer.sha256, f.receipt.artifact.sha256);
});

test('settlement (verify PASS + accept) keeps the pointer and the public read projects it, resolved', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  f.reviews.verify('commons', REVIEWER, id, f.input('pass', 0, { verdict: 'PASS' }));
  f.reviews.decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const stamped = f.stored();
  assert.equal(stamped.state, 'verified');
  assert.deepEqual(stamped.sourcePointer, f.receipt.sourcePointer);
  const pub = publicReceiptById(f.store, id);
  assert.equal(pub.state, 'verified');
  assert.deepEqual(pub.sourcePointer, f.receipt.sourcePointer);
  assert.deepEqual(receiptJson(pub).sourcePointer, f.receipt.sourcePointer);
  const listed = queryPublicReceipts(f.store, {}).receipts.find(entry => entry.id === id);
  assert.deepEqual(listed.sourcePointer, f.receipt.sourcePointer);
  // The proof leg: the projected pointer RESOLVES — the bytes at the
  // named source hash to exactly the digest the verification claims.
  assert.equal(resolvePointer(f.store, pub.sourcePointer), true);
});

test('rejection is a settlement too: the pointer is present and resolves', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  f.reviews.verify('commons', REVIEWER, id, f.input('pass', 0, { verdict: 'PASS' }));
  f.reviews.decide('commons', 'owner', id, f.input('reject', 1, { decision: 'rejected' }));
  const pub = publicReceiptById(f.store, id);
  assert.equal(pub.state, 'rejected');
  assert.deepEqual(pub.sourcePointer, f.receipt.sourcePointer);
  assert.equal(resolvePointer(f.store, pub.sourcePointer), true);
});

test('a pointer whose target bytes were altered does not resolve', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  const pub = publicReceiptById(f.store, id);
  assert.equal(resolvePointer(f.store, pub.sourcePointer), true);
  f.store.db.prepare('UPDATE public_work_receipts SET artifact_text=? WHERE receipt_id=?').run('forged bytes', id);
  assert.equal(resolvePointer(f.store, pub.sourcePointer), false);
});

test('a recorded pointer contradicting the record is not projected', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  const record = f.stored();
  record.sourcePointer = { ...record.sourcePointer, sha256: sha256('some other bytes') };
  f.store.db.prepare('UPDATE public_work_receipts SET receipt_json=? WHERE receipt_id=?').run(JSON.stringify(record), id);
  const pub = publicReceiptById(f.store, id);
  assert.equal(pub.sourcePointer, undefined);
});

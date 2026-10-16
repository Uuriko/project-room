// #3733: a public-work receipt's public face must carry its outcome.
// QA-M1 found a verified/accepted pwr_ receipt and a REJECTED one were
// byte-identical to a stranger (page, .json, listing) and the canonical
// read kept saying "submitted" after rejection. These tests drive the
// real finish -> verify -> decide flow and read every stranger surface
// with no credentials: the outcome must match the underlying records,
// a rejected receipt must read as rejected, an undecided one must not
// claim an outcome, and no member-side review field (identity, reason,
// fingerprint) may leak.
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { publicReceiptById, queryPublicReceipts } from '../server/receipts-live.mjs';
import { renderReceiptDetailHtml, renderReceiptsHtml, receiptJson, receiptsListJson } from '../server/receipts-page.mjs';

function fixture(t, mode) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const worker = store.identities.create('Outcome worker');
  const reviewers = mode === 'agent' ? ['reviewer'] : ['owner'];
  const finish = (offerId, checksReported) => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${offerId}`, offerId, reviewerMemberIds: reviewers,
      terms: { kind: 'task', title: `Task ${offerId}`, summary: 'Outcome fixture', acceptanceCriteria: ['Correct result'],
        repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
    store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: `publish-${offerId}`, expectedRevision: 1 });
    store.publicWorkClaims.enable('commons', 'owner', offerId, { requestId: `enable-${offerId}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
    store.publicWorkClaims.act(offerId, worker.secret, 'claim', { requestId: `claim-${offerId}`, expectedTermsVersion: 1 });
    return store.publicWorkClaims.act(offerId, worker.secret, 'finish', { requestId: `finish-${offerId}`, expectedTermsVersion: 1, generation: 1, artifactText: `artifact for ${offerId}`, checksReported }).receipt;
  };
  const input = (receipt, requestId, revision, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact', ...extra });
  const stored = receiptId => JSON.parse(store.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(receiptId).receipt_json);
  t.after(() => store.close());
  return { store, reviews: new PublicWorkReviews(store), finish, input, stored };
}

test('accepted public-work receipt: every stranger surface states the outcome', t => {
  const f = fixture(t, 'agent');
  const receipt = f.finish('accepted-task', ['ran the checks']);
  const id = receipt.receiptId;
  f.reviews.verify('commons', 'reviewer', id, f.input(receipt, 'pass', 0, { verdict: 'PASS' }));
  // Mid-state: a PASS verdict is public, but no outcome is claimed yet.
  const mid = publicReceiptById(f.store, id);
  assert.equal(mid.state, 'submitted');
  assert.equal(mid.review.state, 'pending');
  assert.equal(mid.review.verificationVerdict, 'PASS');
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'submitted');
  f.reviews.decide('commons', 'reviewer', id, f.input(receipt, 'accept', 1, { decision: 'accepted' }));
  const pub = publicReceiptById(f.store, id);
  assert.equal(pub.state, 'accepted');
  assert.equal(pub.verification, 'hash_only');
  assert.deepEqual(pub.checksReported, ['ran the checks']);
  assert.deepEqual(Object.keys(pub.review).sort(), ['decidedAt', 'state', 'verificationReviewerKind', 'verificationVerdict', 'verifiedAt']);
  assert.equal(pub.review.state, 'accepted');
  assert.equal(pub.review.verificationVerdict, 'PASS');
  assert.equal(pub.review.verificationReviewerKind, 'agent');
  assert.ok(pub.review.verifiedAt && pub.review.decidedAt);
  // Canonical read composes the same outcome; the stored record never moves.
  const canonical = f.store.publicWorkClaims.receipt(id);
  assert.equal(canonical.state, 'accepted');
  assert.deepEqual(canonical.review, pub.review);
  assert.deepEqual(f.stored(id), receipt);
  // .json and page state it too.
  const json = receiptJson(pub);
  assert.equal(json.state, 'accepted'); assert.equal(json.review.verificationVerdict, 'PASS');
  const html = renderReceiptDetailHtml(pub);
  assert.match(html, /Accepted — the designated reviewer accepted this delivery\./);
  assert.match(html, /Reviewer verdict<\/dt><dd>PASS \(agent reviewer\)/);
  // The review's binding fingerprint and the reviewer's member id stay member-side.
  const reviewRow = JSON.parse(f.store.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(id).state_json);
  assert.ok(reviewRow.verification.fingerprint);
  for (const surface of [JSON.stringify(json), html]) {
    assert.equal(surface.includes(reviewRow.verification.fingerprint), false);
    assert.equal(surface.includes('"reviewer"'), false);
  }
});

test('rejected public-work receipt reads as rejected everywhere; undecided claims no outcome', t => {
  const f = fixture(t, 'human');
  const rejected = f.finish('rejected-task', []);
  const pending = f.finish('pending-task', ['self check']);
  f.reviews.decide('commons', 'owner', rejected.receiptId, f.input(rejected, 'reject', 0, { decision: 'rejected', reason: 'DO-NOT-PUBLISH-REASON-3733' }));
  const pubRejected = publicReceiptById(f.store, rejected.receiptId);
  const pubPending = publicReceiptById(f.store, pending.receiptId);
  assert.equal(pubRejected.state, 'rejected');
  assert.equal(pubRejected.review.state, 'rejected');
  assert.ok(pubRejected.review.decidedAt);
  assert.equal(pubPending.state, 'submitted');
  assert.equal(pubPending.review, undefined); // no review recorded, no review block
  assert.equal(f.store.publicWorkClaims.receipt(rejected.receiptId).state, 'rejected');
  assert.equal(f.store.publicWorkClaims.receipt(pending.receiptId).state, 'submitted');
  assert.deepEqual(f.stored(rejected.receiptId), rejected);
  // The two receipts differ in outcome on the JSON face, not just title/id.
  const a = receiptJson(pubRejected), b = receiptJson(pubPending);
  assert.notDeepEqual({ state: a.state, review: a.review }, { state: b.state, review: b.review });
  // Listing JSON + HTML carry the same distinction.
  const list = receiptsListJson(queryPublicReceipts(f.store, {}));
  const byId = Object.fromEntries(list.receipts.map(entry => [entry.id, entry]));
  assert.equal(byId[rejected.receiptId].state, 'rejected');
  assert.equal(byId[pending.receiptId].state, 'submitted');
  const listHtml = renderReceiptsHtml(queryPublicReceipts(f.store, {}));
  assert.match(listHtml, /Rejected/);
  const html = renderReceiptDetailHtml(pubRejected);
  assert.match(html, /Rejected — the designated reviewer rejected this delivery\./);
  assert.match(html, /reviewer decision shown above is the room's recorded outcome/);
  const pendingHtml = renderReceiptDetailHtml(pubPending);
  assert.match(pendingHtml, /Submitted — no reviewer decision is recorded yet\./);
  // Privacy invariant: member-side review facts never reach a stranger.
  const reviewRow = JSON.parse(f.store.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(rejected.receiptId).state_json);
  for (const surface of [JSON.stringify(a), html, listHtml]) {
    assert.equal(surface.includes('DO-NOT-PUBLISH-REASON-3733'), false);
    assert.equal(surface.includes(reviewRow.verification?.fingerprint ?? 'no-fingerprint'), false);
    assert.equal(surface.includes('"owner"'), false); // the deciding member id is not projected
  }
});

// #3733, reconciled with the settlement train (#3627/#3566): a
// public-work receipt's faces must carry its outcome, composed from the
// two records that hold the truth — the receipt record the train stamps
// on acceptance (state "verified", tier, executed checks) and the review
// record (verdict + decision). QA-M1 found a verified/accepted pwr_
// receipt and a REJECTED one byte-identical to a stranger; the original
// fix (#3760) predated the train and composed a pre-train model, so this
// suite pins the reconciled contract: acceptance surfaces as the stamp's
// own word ("verified"), rejection and revision requests surface as the
// decision, an undecided receipt claims no outcome, settlement moves
// exactly as the train's own suites pin it, and no member-side review
// fact (decider id on public faces, reason, fingerprint) ever leaks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { publicReceiptById, queryPublicReceipts } from '../server/receipts-live.mjs';
import { renderReceiptDetailHtml, renderReceiptsHtml, receiptJson, receiptsListJson } from '../server/receipts-page.mjs';

const REVIEWER = 'rev-3733-member';
const REASON = 'DO-NOT-PUBLISH-REASON-3733';

function unpaidFixture(t, mode) {
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const state = structuredClone(store.room('commons').state);
  state.members[REVIEWER] = { id: REVIEWER, revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const worker = store.identities.create('Outcome worker');
  const reviewers = mode === 'agent' ? [REVIEWER] : ['owner'];
  const finish = (offerId, extra = {}) => {
    store.projectOffers.create('commons', 'owner', { requestId: `create-${offerId}`, offerId, reviewerMemberIds: reviewers,
      terms: { kind: 'task', title: `Task ${offerId}`, summary: 'Outcome fixture', acceptanceCriteria: ['Correct result'],
        repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
    store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: `publish-${offerId}`, expectedRevision: 1 });
    store.publicWorkClaims.enable('commons', 'owner', offerId, { requestId: `enable-${offerId}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
    store.publicWorkClaims.act(offerId, worker.secret, 'claim', { requestId: `claim-${offerId}`, expectedTermsVersion: 1 });
    return store.publicWorkClaims.act(offerId, worker.secret, 'finish', { requestId: `finish-${offerId}`, expectedTermsVersion: 1, generation: 1,
      artifactText: `artifact for ${offerId}`, checksReported: ['unit: pass'], ...extra }).receipt;
  };
  const input = (receipt, requestId, revision, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: REASON, ...extra });
  const storedRaw = receiptId => store.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(receiptId).receipt_json;
  const stored = receiptId => JSON.parse(storedRaw(receiptId));
  const reviewRow = receiptId => JSON.parse(store.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(receiptId).state_json);
  t.after(() => store.close());
  return { store, reviews: new PublicWorkReviews(store), finish, input, stored, storedRaw, reviewRow };
}

// The paid fixture mirrors tests/public-work-settlement.test.js: real
// escrow journal, genesis-funded owner/worker, exact milli-credit vectors.
function paidFixture(t, amountMinor) {
  const dir = mkdtempSync(join(tmpdir(), 'public-outcome-paid-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.worker = { id: 'worker', revision: 1, kind: 'agent', active: true, displayName: 'Worker', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', producer.identityId, 'worker', Date.now());
  store.bountyEscrow.ensureGenesis('commons');
  const terms = { kind: 'task', title: 'Paid public task', summary: 'Settle me', acceptanceCriteria: ['Correct result'],
    repositoryUrl: 'https://github.com/example/project', reward: { kind: 'work_trade', unit: 'credit', amountMinor }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'paid-task', reviewerMemberIds: ['owner'], terms });
  store.projectOffers.transition('commons', 'owner', 'paid-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'paid-task',
    { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('paid-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('paid-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['checked'] }).receipt;
  const decideInput = (requestId, decision) => ({ requestId, expectedReviewRevision: 0, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: REASON, decision });
  const millis = account => ['payable', 'locked', 'attributed', 'approved'].map(lotState =>
    store.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id='commons' AND account_id=? AND lot_state=?").get(account, lotState).t);
  const journalCount = () => store.db.prepare('SELECT count(*) AS n FROM bounty_journal').get().n;
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, receipt, decideInput, millis, journalCount };
}

test('accepted public-work receipt: the stamp is the outcome face, bound to the review', t => {
  const f = unpaidFixture(t, 'agent');
  const receipt = f.finish('accepted-task', { criteriaAttestation: [{ criterion: 'Correct result', status: 'met' }] });
  const id = receipt.receiptId;
  assert.equal(receipt.verification, 'system_checked'); // finish-time coverage passed
  // Unreviewed: the faces carry the record's own facts and claim no outcome.
  const fresh = publicReceiptById(f.store, id);
  assert.equal(fresh.state, 'submitted');
  assert.deepEqual(fresh.verification, { state: 'system_checked' });
  assert.deepEqual(fresh.executedChecks, [{ name: 'criteria_coverage', result: 'pass' }]);
  assert.deepEqual(fresh.checksReported, ['unit: pass']);
  assert.equal(fresh.review, undefined);
  assert.equal(Object.hasOwn(f.store.publicWorkClaims.receipt(id), 'review'), false);
  // Mid-state: a PASS verdict is public, but no outcome is claimed yet.
  f.reviews.verify('commons', REVIEWER, id, f.input(receipt, 'pass', 0, { verdict: 'PASS' }));
  const mid = publicReceiptById(f.store, id);
  assert.equal(mid.state, 'submitted');
  assert.deepEqual(Object.keys(mid.review).sort(), ['decidedAt', 'state', 'verificationReviewerKind', 'verificationVerdict', 'verifiedAt']);
  assert.equal(mid.review.state, 'pending');
  assert.equal(mid.review.verificationVerdict, 'PASS');
  assert.equal(mid.review.verificationReviewerKind, 'agent');
  assert.ok(mid.review.verifiedAt); assert.equal(mid.review.decidedAt, null);
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'submitted');
  // Decide: acceptance stamps the record; every face reads the stamp.
  f.reviews.decide('commons', REVIEWER, id, f.input(receipt, 'accept', 1, { decision: 'accepted' }));
  const pub = publicReceiptById(f.store, id);
  assert.equal(pub.state, 'verified');
  assert.deepEqual(pub.verification, { state: 'system_checked' });
  assert.deepEqual(pub.executedChecks, [{ name: 'criteria_coverage', result: 'pass' }, { name: 'artifact_integrity', result: 'pass' }]);
  assert.equal(pub.review.state, 'accepted');
  assert.ok(pub.review.decidedAt);
  // Canonical read = the stamped stored record + the review summary, exactly.
  const canonical = f.store.publicWorkClaims.receipt(id);
  const { review: canonicalReview, ...canonicalRecord } = canonical;
  assert.deepEqual(canonicalRecord, f.stored(id));
  assert.deepEqual(canonicalReview, pub.review);
  assert.equal(canonical.verified.by, REVIEWER);
  assert.equal(canonical.verified.passVerdict, 'PASS');
  // Composed reads never move the stored record.
  const rawBefore = f.storedRaw(id);
  f.store.publicWorkClaims.receipt(id); publicReceiptById(f.store, id);
  assert.equal(f.storedRaw(id), rawBefore);
  // .json and page state it too.
  const json = receiptJson(pub);
  assert.equal(json.state, 'verified'); assert.equal(json.review.verificationVerdict, 'PASS');
  const html = renderReceiptDetailHtml(pub);
  assert.match(html, /Verified — the designated reviewer accepted this delivery/);
  assert.match(html, /Recorded check verdict<\/dt><dd>PASS \(agent reviewer\)/);
  assert.match(html, /artifact_integrity — pass/);
  // Member-side review facts never reach a stranger surface: not the
  // reason, not the binding fingerprint, not the decider's member id.
  const fingerprint = f.reviewRow(id).verification.fingerprint;
  assert.ok(fingerprint);
  for (const surface of [JSON.stringify(json), html, JSON.stringify(pub)]) {
    assert.equal(surface.includes(REASON), false);
    assert.equal(surface.includes(fingerprint), false);
    assert.equal(surface.includes(REVIEWER), false);
  }
});

test('rejected public-work receipt reads as rejected everywhere; undecided claims no outcome', t => {
  const f = unpaidFixture(t, 'human');
  const rejected = f.finish('rejected-task');
  const pending = f.finish('pending-task');
  f.reviews.decide('commons', 'owner', rejected.receiptId, f.input(rejected, 'reject', 0, { decision: 'rejected' }));
  // A rejection never stamps: the stored record is the minted record, byte for byte.
  assert.deepEqual(f.stored(rejected.receiptId), rejected);
  const pubRejected = publicReceiptById(f.store, rejected.receiptId);
  const pubPending = publicReceiptById(f.store, pending.receiptId);
  assert.equal(pubRejected.state, 'rejected');
  assert.equal(pubRejected.review.state, 'rejected');
  assert.ok(pubRejected.review.decidedAt);
  assert.equal(pubPending.state, 'submitted');
  assert.equal(pubPending.review, undefined); // no review recorded, no review block
  assert.equal(f.store.publicWorkClaims.receipt(rejected.receiptId).state, 'rejected');
  assert.deepEqual(f.store.publicWorkClaims.receipt(rejected.receiptId).review, pubRejected.review);
  assert.equal(f.store.publicWorkClaims.receipt(pending.receiptId).state, 'submitted');
  assert.deepEqual(f.stored(pending.receiptId), pending);
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
  assert.match(listHtml, /Submitted/);
  const html = renderReceiptDetailHtml(pubRejected);
  assert.match(html, /Rejected — the designated reviewer rejected this delivery\./);
  assert.match(html, /reviewer decision shown above is the room's recorded outcome/);
  const pendingHtml = renderReceiptDetailHtml(pubPending);
  assert.match(pendingHtml, /Submitted — no reviewer decision is recorded yet\./);
  for (const surface of [JSON.stringify(a), html, listHtml]) {
    assert.equal(surface.includes(REASON), false);
    assert.equal(surface.includes('"owner"'), false); // the deciding member id is not projected
  }
});

test('FAIL verdict and revision request read truthfully, and a later acceptance still lands as verified', t => {
  const f = unpaidFixture(t, 'agent');
  // Agent-mode offers name the agent reviewer for both verify and decide.
  const receipt = f.finish('revise-task');
  const id = receipt.receiptId;
  f.reviews.verify('commons', REVIEWER, id, f.input(receipt, 'fail', 0, { verdict: 'FAIL' }));
  const failed = publicReceiptById(f.store, id);
  assert.equal(failed.state, 'submitted');
  assert.equal(failed.review.state, 'pending');
  assert.equal(failed.review.verificationVerdict, 'FAIL');
  f.reviews.decide('commons', REVIEWER, id, f.input(receipt, 'revise', 1, { decision: 'revision_requested' }));
  const revised = publicReceiptById(f.store, id);
  assert.equal(revised.state, 'revision_requested');
  assert.equal(revised.review.state, 'revision_requested');
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'revision_requested');
  assert.deepEqual(f.stored(id), receipt); // revision requests never stamp either
  // revision_requested is not terminal: a fresh PASS and an acceptance
  // move the same receipt to the train's verified state.
  f.reviews.verify('commons', REVIEWER, id, f.input(receipt, 'pass-2', 2, { verdict: 'PASS' }));
  f.reviews.decide('commons', REVIEWER, id, f.input(receipt, 'accept-2', 3, { decision: 'accepted' }));
  const accepted = publicReceiptById(f.store, id);
  assert.equal(accepted.state, 'verified');
  assert.equal(accepted.review.state, 'accepted');
  assert.equal(accepted.review.verificationVerdict, 'PASS');
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'verified');
});

test('paid acceptance: settlement moves exactly as the train pins it, and the faces follow', t => {
  const f = paidFixture(t, '4000'), { store } = f;
  const receipt = f.receipt, id = receipt.receiptId;
  // Reads before the verdict move nothing.
  const journalBefore = f.journalCount();
  publicReceiptById(store, id); store.publicWorkClaims.receipt(id);
  assert.equal(f.journalCount(), journalBefore);
  const outcome = store.publicWorkReviews.decide('commons', 'owner', id, f.decideInput('accept-1', 'accepted'));
  assert.equal(outcome.review.state, 'accepted');
  assert.equal(outcome.settlement.phase, 'accepted');
  // The train's own accept-path vectors (public-work-settlement.test.js).
  assert.deepEqual(f.millis('owner'), [96_000, 0, 0, 0]);
  assert.deepEqual(f.millis('worker'), [99_000, 1_000, 4_000, 0]);
  assert.equal(store.bountyEscrow.verifyConservation('commons').ok, true);
  // Faces: human-mode acceptance with no executed checks stamps verified
  // at the honest hash_only tier.
  const pub = publicReceiptById(store, id);
  assert.equal(pub.state, 'verified');
  assert.deepEqual(pub.verification, { state: 'hash_only' });
  assert.equal(pub.review.state, 'accepted');
  const canonical = store.publicWorkClaims.receipt(id);
  assert.equal(canonical.state, 'verified');
  assert.equal(canonical.verified.passVerdict, null);
  // Reads after the verdict move nothing either.
  const journalAfter = f.journalCount();
  publicReceiptById(store, id); store.publicWorkClaims.receipt(id); queryPublicReceipts(store, {});
  assert.equal(f.journalCount(), journalAfter);
});

test('paid rejection: full feeless refund exactly as the train pins it, faces read rejected', t => {
  const f = paidFixture(t, '2000'), { store } = f;
  const receipt = f.receipt, id = receipt.receiptId;
  const outcome = store.publicWorkReviews.decide('commons', 'owner', id, f.decideInput('reject-1', 'rejected'));
  assert.equal(outcome.review.state, 'rejected');
  assert.equal(outcome.settlement.phase, 'refunded');
  // The train's own reject-path vectors (public-work-settlement.test.js):
  // award back to the poster in full; the claim bond is forfeited to the pool.
  assert.deepEqual(f.millis('owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(f.millis('worker'), [99_000, 0, 0, 0]);
  assert.deepEqual(f.millis('pool'), [1_000, 0, 0, 0]);
  assert.equal(store.bountyEscrow.verifyConservation('commons').ok, true);
  const pub = publicReceiptById(store, id);
  assert.equal(pub.state, 'rejected');
  assert.equal(pub.review.state, 'rejected');
  assert.equal(store.publicWorkClaims.receipt(id).state, 'rejected');
  // The stored record was never stamped or rewritten by the verdict.
  assert.deepEqual(JSON.parse(store.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(id).receipt_json), receipt);
  const journalAfter = f.journalCount();
  publicReceiptById(store, id); store.publicWorkClaims.receipt(id);
  assert.equal(f.journalCount(), journalAfter);
});

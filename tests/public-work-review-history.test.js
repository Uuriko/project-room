// W3 review-history versioning (data preservation): every re-review used
// to OVERWRITE the previous verdict in public_work_reviews.state_json —
// the prior verdict, its author and its rationale were destroyed. The
// current row is now a pointer: mutate() also appends an immutable row to
// public_work_review_versions (same transaction, 1:1 with revisions;
// journal replays return earlier and append nothing), and the member-side
// inspect door reads the full history back in revision order.
//
// Door-level contract pinned here (the charter's test): re-review twice,
// then read back all three versions in order — FAIL, PASS, accept — each
// with its author, timestamp and rationale, while the current view still
// shows only the latest verdict. The owner results list stays lean, the
// contributor door is unchanged, and a review with no version rows
// (pre-versioning data) reads an empty history — gone, not fabricated.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';

// Mirrors tests/public-work-reviews.test.js: real persisted offers,
// identities, public claim kernel and immutable receipts.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-review-history-')), file = join(dir, 'room.sqlite');
  let store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'review-task', reviewerMemberIds: ['owner', 'reviewer'],
    terms: { kind: 'task', title: 'Review this result', summary: 'Explicit feedback', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human_with_agent_review' } } });
  store.projectOffers.transition('commons', 'owner', 'review-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'review-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('review-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('review-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: '<not-html>🐈', checksReported: ['Caller reports success'] }).receipt;
  const service = () => new PublicWorkReviews(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, service, receipt, producer, file,
    reopen() { store.close(); store = new RoomStore(file); },
    input(requestId, revision = 0, extra = {}) { return { requestId, expectedReviewRevision: revision, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact', ...extra }; } };
}

const versionRows = (store, receiptId) =>
  store.db.prepare('SELECT revision, action, actor_id, at, state_json FROM public_work_review_versions WHERE receipt_id=? ORDER BY revision ASC').all(receiptId);

test('re-review twice, read back all three versions in order; current stays a pointer', t => {
  const f = fixture(t), id = f.receipt.receiptId;

  const failed = f.service().verify('commons', 'reviewer', id, f.input('v1-fail', 0, { verdict: 'FAIL', reason: 'Misses the acceptance criteria' }));
  assert.equal(failed.review.revision, 1);
  assert.deepEqual(failed.history.map(entry => entry.revision), [1], 'the mutation outcome already carries the history it wrote');

  const passed = f.service().verify('commons', 'reviewer', id, f.input('v2-pass', 1, { verdict: 'PASS', reason: 'Criteria met on re-check' }));
  assert.equal(passed.review.revision, 2);
  assert.deepEqual(passed.history.map(entry => entry.revision), [1, 2]);

  const decideArgs = f.input('v3-accept', 2, { decision: 'accepted', reason: 'Accepting the verified result' });
  const accepted = f.service().decide('commons', 'owner', id, decideArgs);
  assert.equal(accepted.review.revision, 3);
  assert.equal(accepted.review.state, 'accepted');
  assert.deepEqual(accepted.history.map(entry => entry.revision), [1, 2, 3]);

  // The door-level read: inspect returns every version, in order, each
  // with author, timestamp and rationale intact.
  const view = f.service().inspect('commons', 'owner', id);
  assert.equal(view.review.revision, 3, 'current pointer is the latest revision');
  assert.equal(view.review.state, 'accepted');
  assert.equal(view.review.verification.verdict, 'PASS', 'current verification is only the latest verdict');
  assert.equal(view.history.length, 3);
  const [v1, v2, v3] = view.history;
  assert.equal(v1.action, 'verify'); assert.equal(v1.actorId, 'reviewer');
  assert.equal(v1.verification.verdict, 'FAIL'); assert.equal(v1.verification.reason, 'Misses the acceptance criteria');
  assert.equal(v1.decision, null); assert.equal(v1.state, 'pending');
  assert.equal(v2.action, 'verify'); assert.equal(v2.actorId, 'reviewer');
  assert.equal(v2.verification.verdict, 'PASS'); assert.equal(v2.verification.reason, 'Criteria met on re-check');
  assert.equal(v3.action, 'decide'); assert.equal(v3.actorId, 'owner');
  assert.equal(v3.decision.decision, 'accepted'); assert.equal(v3.decision.reason, 'Accepting the verified result');
  assert.equal(v3.state, 'accepted');
  for (const entry of view.history) assert.equal(typeof entry.at, 'string');
  for (const entry of view.history) assert.ok(entry.at.length > 0);

  // The overwritten FAIL survives in the immutable store even though the
  // pointer row moved on; the fingerprint never rides the history door.
  const rows = versionRows(f.store, id);
  assert.equal(rows.length, 3);
  assert.equal(JSON.parse(rows[0].state_json).verification.verdict, 'FAIL');
  assert.equal(JSON.parse(rows[2].state_json).decision.decision, 'accepted');
  const fingerprint = JSON.parse(f.store.db.prepare('SELECT state_json FROM public_work_reviews WHERE receipt_id=?').get(id).state_json).verification.fingerprint;
  assert.equal(typeof fingerprint, 'string');
  assert.equal(JSON.stringify(view.history).includes(fingerprint), false, 'fingerprint stays in the evidence record');

  // A journal replay returns the recorded outcome and appends no version.
  assert.deepEqual(f.service().decide('commons', 'owner', id, decideArgs), accepted);
  assert.equal(versionRows(f.store, id).length, 3, 'replays never duplicate a version');

  // History is durable: it survives a store reopen.
  f.reopen();
  const reopened = f.service().inspect('commons', 'owner', id);
  assert.deepEqual(reopened.history.map(entry => [entry.revision, entry.action]), [[1, 'verify'], [2, 'verify'], [3, 'decide']]);
});

test('results list stays lean and the contributor door is unchanged', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.service().verify('commons', 'reviewer', id, f.input('only-fail', 0, { verdict: 'FAIL', reason: 'Not yet' }));
  const listed = f.service().results('commons', 'owner').results[0];
  assert.equal(Object.hasOwn(listed, 'history'), false, 'the owner results list does not grow a history payload');
  const own = f.service().contributorReview(f.producer.secret, id);
  assert.equal(Object.hasOwn(own, 'history'), false);
  assert.equal(own.review.verificationVerdict, 'FAIL', 'contributor feedback still reads the current pointer only');
});

test('a review with no version rows reads an empty history, never a fabricated one', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  assert.deepEqual(f.service().inspect('commons', 'owner', id).history, [], 'unreviewed receipt: empty history');
  f.service().verify('commons', 'reviewer', id, f.input('legacy-pass', 0, { verdict: 'PASS' }));
  // Simulate pre-versioning data: a pointer row whose history was never
  // versioned (the overwritten verdicts of the old regime).
  f.store.db.prepare('DELETE FROM public_work_review_versions WHERE receipt_id=?').run(id);
  const view = f.service().inspect('commons', 'owner', id);
  assert.equal(view.review.revision, 1, 'the pointer still reads');
  assert.equal(view.review.verification.verdict, 'PASS');
  assert.deepEqual(view.history, [], 'lost history reads as absent, not invented');
});

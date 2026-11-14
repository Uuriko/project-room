// #3546/#3547 on the public-work surface: the finish-time criteria leg is
// executed against the offer (not trusted), a verify PASS re-hashes the
// stored artifact itself, and acceptance moves the public receipt from
// submitted (delivered) to verified with the executed checks on record.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { publicReceiptById, publicWorkReceiptOutcome } from '../server/public-read-model.mjs';

const code = expected => error => error.code === expected;

function fixture(t, { attestation, deferFinish = false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-verified-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'verify-task', reviewerMemberIds: ['owner', 'reviewer'],
    terms: { kind: 'task', title: 'Verify this result', summary: 'Explicit feedback', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human_with_agent_review' } } });
  store.projectOffers.transition('commons', 'owner', 'verify-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'verify-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('verify-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const finish = extra => store.publicWorkClaims.act('verify-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['unit: pass'], ...extra });
  const receipt = deferFinish ? null : finish(attestation === undefined ? {} : { criteriaAttestation: attestation }).receipt;
  const service = () => new PublicWorkReviews(store);
  const input = (requestId, revision = 0, extra = {}) => ({ requestId, expectedReviewRevision: revision, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'Reviewed the exact artifact', ...extra });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, receipt, producer, input, finish };
}

test('finish without attestation: bundle recorded, verification stays hash_only, state submitted', t => {
  const f = fixture(t);
  assert.equal(f.receipt.state, 'submitted');
  assert.equal(f.receipt.verification, 'hash_only');
  assert.equal(f.receipt.criteriaAttestation, null);
  assert.deepEqual(f.receipt.executedChecks, []);
  assert.match(f.receipt.deliveryDigest, /^[0-9a-f]{64}$/);
  const packet = f.store.publicWorkClaims.read('verify-task');
  assert.equal(packet.claim.state, 'submitted');
  assert.equal(packet.claim.verification, 'hash_only');
  assert.equal(packet.claim.deliveryDigest, f.receipt.deliveryDigest);
});

test('finish with attestation: coverage is executed against the offer criteria and recorded', t => {
  const f = fixture(t, { attestation: [{ criterion: 'Correct result', status: 'met', evidenceRef: 'result.txt' }] });
  assert.deepEqual(f.receipt.criteriaAttestation, [{ criterion: 'Correct result', status: 'met', evidenceRef: 'result.txt' }]);
  assert.deepEqual(f.receipt.executedChecks.map(entry => [entry.name, entry.result]), [['criteria_coverage', 'pass']]);
  assert.equal(f.receipt.verification, 'system_checked');
  assert.equal(f.receipt.state, 'submitted');
});

test('finish with an incomplete or duplicated attestation is refused before any receipt exists', t => {
  const missing = fixture(t, { deferFinish: true });
  assert.throws(() => missing.finish({ criteriaAttestation: [] }),
    error => /does not cover criterion "Correct result"/.test(error.message));
  assert.equal(missing.store.publicWorkClaims.read('verify-task').claim.state, 'claimed');
  const duplicated = fixture(t, { deferFinish: true });
  assert.throws(() => duplicated.finish({ criteriaAttestation: [
    { criterion: 'Correct result', status: 'met' }, { criterion: 'Correct result', status: 'met' }] }),
    error => /more than once/.test(error.message));
});

test('verify PASS executes artifact integrity; acceptance stamps the receipt verified', t => {
  const f = fixture(t, { attestation: [{ criterion: 'Correct result', status: 'met' }] });
  const id = f.receipt.receiptId;
  const passed = f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS' }));
  assert.deepEqual(passed.review.verification.executedChecks.map(entry => entry.name), ['artifact_integrity']);
  f.service().decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const stamped = f.store.publicWorkClaims.receipt(id);
  assert.equal(stamped.state, 'verified');
  assert.equal(stamped.verification, 'system_checked');
  assert.deepEqual(stamped.executedChecks.map(entry => entry.name), ['criteria_coverage', 'artifact_integrity']);
  assert.equal(stamped.verified.by, 'owner');
  assert.equal(stamped.verified.passVerdict, 'PASS');
  assert.equal(stamped.artifact.sha256, f.receipt.artifact.sha256);
  const packet = f.store.publicWorkClaims.read('verify-task');
  assert.equal(packet.claim.state, 'verified');
  assert.equal(packet.claim.verification, 'system_checked');
});

test('tampered stored bytes block a PASS with artifact_integrity_failed; a FAIL verdict still records', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  f.store.db.prepare('UPDATE public_work_receipts SET artifact_text=? WHERE receipt_id=?').run('tampered bytes', id);
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS' })),
    code('artifact_integrity_failed'));
  const failed = f.service().verify('commons', 'reviewer', id, f.input('fail', 0, { verdict: 'FAIL' }));
  assert.equal(failed.review.verification.verdict, 'FAIL');
  assert.equal(failed.review.verification.executedChecks, undefined);
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'submitted');
});

test('#3613 B1+B4: the receipt binds the pinned criteria set and the work period', t => {
  const f = fixture(t, { attestation: [{ criterion: 'Correct result', status: 'met' }] });
  assert.deepEqual(f.receipt.acceptanceCriteriaWithIds, [{ criterionId: 'c1', text: 'Correct result' }]);
  assert.match(f.receipt.criteriaHash, /^[a-f0-9]{64}$/);
  const packet = f.store.publicWorkClaims.read('verify-task');
  assert.deepEqual(packet.acceptanceCriteriaWithIds, f.receipt.acceptanceCriteriaWithIds);
  assert.equal(packet.criteriaHash, f.receipt.criteriaHash);
  // Period: claimed at the claim transition, submitted at this receipt's
  // own createdAt — never the other way round.
  assert.equal(f.receipt.period.submittedAt, f.receipt.createdAt);
  assert.ok(Number.isFinite(Date.parse(f.receipt.period.claimedAt)));
  assert.ok(Date.parse(f.receipt.period.claimedAt) <= Date.parse(f.receipt.period.submittedAt));
  // The public face projects the same period.
  assert.deepEqual(publicReceiptById(f.store, f.receipt.receiptId).period, f.receipt.period);
  // The verified stamp preserves the period and the pin byte-for-byte.
  const id = f.receipt.receiptId;
  f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS' }));
  f.service().decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const stamped = f.store.publicWorkClaims.receipt(id);
  assert.equal(stamped.state, 'verified');
  assert.deepEqual(stamped.period, f.receipt.period);
  assert.equal(stamped.criteriaHash, f.receipt.criteriaHash);
});

test('#3613 B1: finish attestation may cite a criterion by its pinned id', t => {
  const byId = fixture(t, { deferFinish: true });
  const done = byId.finish({ criteriaAttestation: [{ criterionId: 'c1', status: 'met' }] });
  // Stored in the legacy text-keyed shape; coverage executed as a pass.
  assert.deepEqual(done.receipt.criteriaAttestation, [{ criterion: 'Correct result', status: 'met' }]);
  assert.deepEqual(done.receipt.executedChecks.map(entry => [entry.name, entry.result]), [['criteria_coverage', 'pass']]);
  const unknown = fixture(t, { deferFinish: true });
  assert.throws(() => unknown.finish({ criteriaAttestation: [{ criterionId: 'c9', status: 'met' }] }),
    error => /unknown criterionId "c9"/.test(error.message));
  const mismatch = fixture(t, { deferFinish: true });
  assert.throws(() => mismatch.finish({ criteriaAttestation: [{ criterionId: 'c1', criterion: 'Something else', status: 'met' }] }),
    error => /does not match its criterionId/.test(error.message));
});

test('#3613 B2: reviewer per-criterion outcomes are validated against the pin and recorded', t => {
  const f = fixture(t, { attestation: [{ criterion: 'Correct result', status: 'met' }] });
  const id = f.receipt.receiptId;
  // Unknown id, empty list and duplicate citations are refused before
  // anything records (the bounty citations contract, mirrored).
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('bad-id', 0, { verdict: 'PASS', criteriaOutcomes: [{ criterionId: 'c9', verdict: 'pass' }] })),
    code('invalid_public_review'));
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('empty', 0, { verdict: 'PASS', criteriaOutcomes: [] })),
    code('invalid_public_review'));
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('dupe', 0, { verdict: 'PASS', criteriaOutcomes: [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c1', verdict: 'fail' }] })),
    code('invalid_public_review'));
  const passed = f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS', criteriaOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] }));
  assert.deepEqual(passed.review.verification.criteriaOutcomes, [{ criterionId: 'c1', verdict: 'pass' }]);
  assert.equal(passed.review.verification.criteriaHash, f.receipt.criteriaHash);
  assert.equal(passed.review.verification.current, true);
  // The public outcome face composes the outcomes beside the pinned hash.
  const pub = publicReceiptById(f.store, id);
  assert.deepEqual(pub.review.criteriaOutcomes, [{ criterionId: 'c1', verdict: 'pass' }]);
  assert.equal(pub.review.criteriaHash, f.receipt.criteriaHash);
});

test('#3613 B2: a PASS with a failed criterion outcome does not count as a current pass', t => {
  const f = fixture(t, { attestation: [{ criterion: 'Correct result', status: 'met' }] });
  const id = f.receipt.receiptId;
  const passed = f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS', criteriaOutcomes: [{ criterionId: 'c1', verdict: 'fail' }] }));
  assert.equal(passed.review.verification.verdict, 'PASS');
  assert.equal(passed.review.verification.current, false);
  // Acceptance is blocked while that PASS is the current one...
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' })), code('review_pass_required'));
  // ...until a fresh PASS with passing outcomes replaces it.
  f.service().verify('commons', 'reviewer', id, f.input('pass-2', 1, { verdict: 'PASS', criteriaOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] }));
  const accepted = f.service().decide('commons', 'owner', id, f.input('accept-2', 2, { decision: 'accepted' }));
  assert.equal(accepted.review.state, 'accepted');
});

test('#3613 B2: criteriaOutcomes stays off the decide action whitelist', t => {
  const f = fixture(t);
  assert.throws(() => f.service().decide('commons', 'owner', f.receipt.receiptId,
    f.input('decide', 0, { decision: 'accepted', criteriaOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] })),
    error => /Unexpected or missing review fields/.test(error.message));
});

test('#3613 B4: a legacy receipt without a period projects exactly as before', t => {
  const f = fixture(t);
  const id = f.receipt.receiptId;
  const row = f.store.db.prepare('SELECT receipt_json FROM public_work_receipts WHERE receipt_id=?').get(id);
  const body = JSON.parse(row.receipt_json); delete body.period;
  f.store.db.prepare('UPDATE public_work_receipts SET receipt_json=? WHERE receipt_id=?').run(JSON.stringify(body), id);
  assert.equal(Object.hasOwn(publicReceiptById(f.store, id), 'period'), false);
  assert.equal(Object.hasOwn(publicWorkReceiptOutcome(f.store, id), 'period'), false);
});

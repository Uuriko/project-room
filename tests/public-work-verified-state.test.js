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
  const passed = f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS', criterionOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] }));
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
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS', criterionOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] })),
    code('artifact_integrity_failed'));
  const failed = f.service().verify('commons', 'reviewer', id, f.input('fail', 0, { verdict: 'FAIL', criterionOutcomes: [{ criterionId: 'c1', verdict: 'fail' }] }));
  assert.equal(failed.review.verification.verdict, 'FAIL');
  assert.equal(failed.review.verification.executedChecks, undefined);
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'submitted');
});

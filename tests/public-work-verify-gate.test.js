import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { statedArtifactFloors, evaluateArtifactFloors } from '../server/artifact-floors.mjs';

// FIX-VERIFY-GATE: the mechanical floors the acceptance criteria state
// are evaluated over the artifact itself before a PASS is recorded. The
// specimen replayed here is the EXP-13R pilot's false-PASS shape, with
// its criteria and its artifact verbatim: five recorded PASSes landed on
// this 64-byte artifact against these criteria.
const PILOT_CRITERIA = [
  'The artifact states the task id, the claim generation observed, and the lease expiry read back at claim time.',
  'The artifact is at least 200 characters of prose (not a poem or placeholder).',
  'The artifact cites the file server/bounty-escrow.mjs.',
];
const HAIKU = 'silent server hums\na haiku for the census\ndisputes sleep soundly';
const CONFORMING = [
  'Delivery for task gate-task, generation 1, against the funded escrow rail.',
  'The claim was read back at claim time and the delivery follows the rules in',
  'server/bounty-escrow.mjs: the artifact states the task id gate-task, the claim',
  'generation observed, and the lease expiry read back at claim time, in prose.',
].join('\n');

function fixture(t, { criteria, artifactText }) {
  const dir = mkdtempSync(join(tmpdir(), 'verify-gate-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'gate-task', reviewerMemberIds: ['reviewer'],
    terms: { kind: 'task', title: 'Gate this result', summary: 'Mechanical floors', acceptanceCriteria: criteria, repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'agent' } } });
  store.projectOffers.transition('commons', 'owner', 'gate-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'gate-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('gate-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('gate-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText, checksReported: ['Caller reports success'] }).receipt;
  const service = () => new PublicWorkReviews(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, receipt,
    input(requestId, revision = 0, extra = {}) { return { requestId, expectedReviewRevision: revision, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact', ...extra }; } };
}
const code = expected => error => error.code === expected;

test('specimen replay: the EXP-13R haiku cannot record a PASS, and the refusal names the failed floors', t => {
  assert.equal(Buffer.byteLength(HAIKU, 'utf8'), 64);
  const f = fixture(t, { criteria: PILOT_CRITERIA, artifactText: HAIKU }), id = f.receipt.receiptId;
  let refusal;
  try { f.service().verify('commons', 'reviewer', id, f.input('pass-attempt', 0, { verdict: 'PASS' })); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'artifact_floor_failed');
  assert.match(refusal.message, /at least 200 characters; the artifact has 64/);
  assert.match(refusal.message, /cite server\/bounty-escrow\.mjs/);
  assert.match(refusal.message, /state the task id gate-task/);
  // No verdict was recorded: the review is still at revision 0, pending.
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_reviews').get().n, 0);
  assert.equal(f.service().inspect('commons', 'reviewer', id).review.revision, 0);
  // A retry of the same PASS against the same artifact is refused again.
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('pass-retry', 0, { verdict: 'PASS' })), code('artifact_floor_failed'));
  // FAIL verdicts are never gated: the same artifact records a FAIL.
  const failed = f.service().verify('commons', 'reviewer', id, f.input('fail', 0, { verdict: 'FAIL' }));
  assert.equal(failed.review.verification.verdict, 'FAIL');
  assert.equal(failed.review.verification.executedChecks, undefined);
});

test('a conforming artifact records PASS with the artifact_floors executed check, and acceptance carries it to the receipt', t => {
  const f = fixture(t, { criteria: PILOT_CRITERIA, artifactText: CONFORMING }), id = f.receipt.receiptId;
  const passed = f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS' }));
  assert.equal(passed.review.verification.verdict, 'PASS');
  assert.deepEqual(passed.review.verification.executedChecks.map(entry => [entry.name, entry.result]),
    [['artifact_integrity', 'pass'], ['artifact_floors', 'pass']]);
  const accepted = f.service().decide('commons', 'reviewer', id, f.input('accept', 1, { decision: 'accepted' }));
  assert.equal(accepted.review.state, 'accepted');
  const stamped = f.store.publicWorkClaims.receipt(id);
  assert.equal(stamped.state, 'verified');
  assert.deepEqual(stamped.executedChecks.map(entry => entry.name), ['artifact_integrity', 'artifact_floors']);
});

test('a partially conforming artifact is refused on only the floor it fails', t => {
  const noTaskId = CONFORMING.replaceAll('gate-task', 'the task');
  const f = fixture(t, { criteria: PILOT_CRITERIA, artifactText: noTaskId }), id = f.receipt.receiptId;
  let refusal;
  try { f.service().verify('commons', 'reviewer', id, f.input('pass-attempt', 0, { verdict: 'PASS' })); } catch (error) { refusal = error; }
  assert.equal(refusal?.code, 'artifact_floor_failed');
  assert.match(refusal.message, /state the task id gate-task/);
  assert.doesNotMatch(refusal.message, /at least 200 characters/);
  assert.doesNotMatch(refusal.message, /cite server\/bounty-escrow\.mjs/);
});

test('criteria stating no floors keep the exact pre-gate PASS behaviour', t => {
  const f = fixture(t, { criteria: ['Correct result'], artifactText: '<not-html>🐈' }), id = f.receipt.receiptId;
  const passed = f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS' }));
  assert.equal(passed.review.verification.verdict, 'PASS');
  assert.deepEqual(passed.review.verification.executedChecks.map(entry => entry.name), ['artifact_integrity']);
});

test('floor extraction: only unambiguous stated forms, measured in the stated unit', () => {
  assert.deepEqual(statedArtifactFloors('The artifact is at least 200 characters of prose (not a poem or placeholder).'),
    [{ kind: 'minimum_length', value: 200, unit: 'characters' }]);
  assert.deepEqual(statedArtifactFloors('The artifact is at least 400 characters of prose analysis, not a poem or placeholder text.'),
    [{ kind: 'minimum_length', value: 400, unit: 'characters' }]);
  assert.deepEqual(statedArtifactFloors('The artifact carries a minimum of 64 bytes of evidence.'),
    [{ kind: 'minimum_length', value: 64, unit: 'bytes' }]);
  // A minimum stated about something else is not an artifact floor.
  assert.deepEqual(statedArtifactFloors('The summary is at least 200 characters.'), []);
  // A citation floor needs the literal path in the criterion.
  assert.deepEqual(statedArtifactFloors('The artifact cites the file server/bounty-escrow.mjs.'),
    [{ kind: 'file_citation', path: 'server/bounty-escrow.mjs' }]);
  assert.deepEqual(statedArtifactFloors('The artifact cites the file path it censuses.'), []);
  // Judgement language alone states no floor.
  assert.deepEqual(statedArtifactFloors('The artifact is a structured census of dispute outcomes.'), []);
  // Character floors count code points, not bytes.
  const floors = evaluateArtifactFloors(['The artifact is at least 3 characters.'], '🐈🐈', { taskId: 'x' });
  assert.equal(floors.failures.length, 1);
  assert.match(floors.failures[0].detail, /the artifact has 2/);
});

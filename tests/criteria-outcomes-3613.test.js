// #3613 (accountability R-2): criteria-level outcomes beyond the bounty
// lane. Offers gain addressable criterion ids derived from the pinned
// acceptanceCriteria list; public-work verification and board claim reviews
// record per-criterion pass|fail outcomes with citationsAgainstRubric
// semantics; the public-work receipt body carries the claim period.
// Patterns follow tests/bounty-rubrics.test.js (citation discipline) and
// tests/public-work-reviews.test.js (persisted review fixture).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { criteriaWithIds, criterionOutcomesAgainst } from '../server/criteria.mjs';
import { createWork, claimWork, updateWork, recordReview, workOf, ClaimError } from '../server/work-claims.mjs';

const check = (ok, message) => { if (!ok) throw Object.assign(new Error(message), { code: 'invalid_test_input' }); };
const throwsCode = (fn, code) => assert.throws(fn, error => error.code === code);

test('criteriaWithIds derives c1-style ids from the pinned list, in order', () => {
  assert.deepEqual(criteriaWithIds(['Alpha', 'Beta']), [
    { criterionId: 'c1', criterion: 'Alpha' },
    { criterionId: 'c2', criterion: 'Beta' },
  ]);
  assert.deepEqual(criteriaWithIds([]), []);
  assert.deepEqual(criteriaWithIds(undefined), []);
});

test('criterionOutcomesAgainst is order-insensitive and returns pinned order', () => {
  const out = criterionOutcomesAgainst(
    [{ criterionId: 'c2', verdict: 'fail' }, { criterionId: 'c1', verdict: 'pass' }],
    ['Alpha', 'Beta'], check);
  assert.deepEqual(out, [
    { criterionId: 'c1', verdict: 'pass' },
    { criterionId: 'c2', verdict: 'fail' },
  ]);
  assert.equal(Object.isFrozen(out), true);
});

test('criterionOutcomesAgainst refuses missing, unknown, duplicate and malformed citations', () => {
  const criteria = ['Alpha', 'Beta'];
  assert.throws(() => criterionOutcomesAgainst(undefined, criteria, check), /required/);
  assert.throws(() => criterionOutcomesAgainst([], criteria, check), /required/);
  assert.throws(() => criterionOutcomesAgainst([{ criterionId: 'c1', verdict: 'pass' }], criteria, check), /"c2" has no outcome/);
  assert.throws(() => criterionOutcomesAgainst(
    [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c9', verdict: 'pass' }], criteria, check), /not one of the pinned criteria/);
  assert.throws(() => criterionOutcomesAgainst(
    [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c1', verdict: 'fail' }, { criterionId: 'c2', verdict: 'pass' }], criteria, check), /at most 2 entries/);
  assert.throws(() => criterionOutcomesAgainst(
    [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c2', verdict: 'met' }], criteria, check), /verdict must be pass or fail/);
  // A criterion cited twice inside the limit is refused by name.
  assert.throws(() => criterionOutcomesAgainst(
    [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c1', verdict: 'pass' }], criteria, check), /cited more than once/);
});

// --- board claim reviews -------------------------------------------------

const boardClaim = (over = {}) => {
  const item = createWork({ id: 'w-crit', title: 'Criteria work', acceptanceCriteria: ['Docs updated', 'Tests green'], ...over }, { agentId: 'quill' });
  return updateWork(claimWork(item, 'quill'), 'quill', { state: 'in_progress' });
};

test('board approve on a criteria-bearing claim requires per-criterion outcomes', () => {
  const active = boardClaim();
  throwsCode(() => recordReview(active, 'sage', { verdict: 'approve', summary: 'checks out' }), 'invalid_claim_input');
  throwsCode(() => recordReview(active, 'sage', { verdict: 'approve', summary: 'checks out',
    criterionOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] }), 'invalid_claim_input');
  // Non-approve verdicts do not require outcomes.
  const commented = recordReview(active, 'sage', { verdict: 'comment', summary: 'looking' });
  assert.equal(commented.reviews[0].criterionOutcomes, undefined);
});

test('board review stores validated outcomes and they round-trip through workOf', () => {
  const active = boardClaim();
  const reviewed = recordReview(active, 'sage', { verdict: 'approve', summary: 'checks out',
    criterionOutcomes: [{ criterionId: 'c2', verdict: 'pass' }, { criterionId: 'c1', verdict: 'pass' }] });
  assert.deepEqual(reviewed.reviews[0].criterionOutcomes, [
    { criterionId: 'c1', verdict: 'pass' },
    { criterionId: 'c2', verdict: 'pass' },
  ]);
  const reloaded = workOf(JSON.parse(JSON.stringify(reviewed)));
  assert.deepEqual(reloaded.reviews[0].criterionOutcomes, reviewed.reviews[0].criterionOutcomes);
  // A changes_requested verdict may also carry outcomes (recorded, validated).
  const sentBack = recordReview(active, 'sage', { verdict: 'changes_requested', summary: 'tests red',
    criterionOutcomes: [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c2', verdict: 'fail' }] });
  assert.deepEqual(sentBack.reviews[0].criterionOutcomes[1], { criterionId: 'c2', verdict: 'fail' });
});

test('board claims without criteria refuse supplied outcomes and approve freely', () => {
  const item = updateWork(claimWork(createWork({ id: 'w-plain', title: 'Plain' }, { agentId: 'quill' }), 'quill'), 'quill', { state: 'in_progress' });
  const reviewed = recordReview(item, 'sage', { verdict: 'approve', summary: 'fine' });
  assert.equal(reviewed.reviews[0].verdict, 'approve');
  assert.throws(() => recordReview(item, 'sage', { verdict: 'comment', summary: 'fine',
    criterionOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] }),
    error => error instanceof ClaimError && error.code === 'invalid_claim_input');
});

// --- public work -----------------------------------------------------------

const CRITERIA = ['Correct result', 'Documented result'];
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'criteria-3613-')), file = join(dir, 'room.sqlite');
  const store = new RoomStore(file);
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'crit-task', reviewerMemberIds: ['owner', 'reviewer'],
    terms: { kind: 'task', title: 'Criteria task', summary: 'Two criteria', acceptanceCriteria: CRITERIA, repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode: 'human_with_agent_review' } } });
  store.projectOffers.transition('commons', 'owner', 'crit-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'crit-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  const claimed = store.publicWorkClaims.act('crit-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('crit-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['unit: pass'] }).receipt;
  const service = () => new PublicWorkReviews(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, service, receipt, claimed,
    input(requestId, revision = 0, extra = {}) { return { requestId, expectedReviewRevision: revision, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed against every criterion', ...extra }; } };
}
const PASS_BOTH = [{ criterionId: 'c1', verdict: 'pass' }, { criterionId: 'c2', verdict: 'pass' }];

test('offer record and task packet expose the derived criteria ids', t => {
  const f = fixture(t);
  const offer = f.store.projectOffers.read('crit-task');
  assert.deepEqual(offer.criteria, [
    { criterionId: 'c1', criterion: 'Correct result' },
    { criterionId: 'c2', criterion: 'Documented result' },
  ]);
  const packet = f.store.publicWorkClaims.read('crit-task');
  assert.deepEqual(packet.criteria, offer.criteria);
  const view = f.service().inspect('commons', 'owner', f.receipt.receiptId);
  assert.deepEqual(view.offer.criteria, offer.criteria);
});

test('finish carries the claim period onto the receipt body', t => {
  const f = fixture(t);
  const item = f.store.workClaims.get(f.claimed.task.namespaceId, 'crit-task');
  assert.equal(typeof item.claimedAt, 'string');
  assert.deepEqual(f.receipt.period, { claimedAt: item.claimedAt, submittedAt: f.receipt.createdAt });
  const read = f.store.publicWorkClaims.receipt(f.receipt.receiptId);
  assert.deepEqual(read.period, f.receipt.period);
});

test('public-work verify requires per-criterion outcomes and stores them on the verdict', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  throwsCode(() => f.service().verify('commons', 'reviewer', id, f.input('no-outcomes', 0, { verdict: 'PASS' })), 'invalid_public_review');
  throwsCode(() => f.service().verify('commons', 'reviewer', id, f.input('partial', 0, { verdict: 'PASS',
    criterionOutcomes: [{ criterionId: 'c1', verdict: 'pass' }] })), 'invalid_public_review');
  throwsCode(() => f.service().verify('commons', 'reviewer', id, f.input('unknown', 0, { verdict: 'PASS',
    criterionOutcomes: [...PASS_BOTH, { criterionId: 'c3', verdict: 'pass' }] })), 'invalid_public_review');
  // FAIL verdicts carry the same discipline — the outcomes are the record.
  throwsCode(() => f.service().verify('commons', 'reviewer', id, f.input('bare-fail', 0, { verdict: 'FAIL' })), 'invalid_public_review');
  const verified = f.service().verify('commons', 'reviewer', id, f.input('full-pass', 0, { verdict: 'PASS',
    criterionOutcomes: [{ criterionId: 'c2', verdict: 'pass' }, { criterionId: 'c1', verdict: 'pass' }] }));
  assert.deepEqual(verified.review.verification.criterionOutcomes, PASS_BOTH);
  // decide cannot smuggle outcomes in; the field belongs to verify only.
  throwsCode(() => f.service().decide('commons', 'owner', id, f.input('decide-with-outcomes', 1, { decision: 'accepted', criterionOutcomes: PASS_BOTH })), 'invalid_public_review');
});

test('acceptance stamps the criteria and outcomes onto the public receipt', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.service().verify('commons', 'reviewer', id, f.input('pass', 0, { verdict: 'PASS', criterionOutcomes: PASS_BOTH }));
  f.service().decide('commons', 'owner', id, f.input('accept', 1, { decision: 'accepted' }));
  const stamped = f.store.publicWorkClaims.receipt(id);
  assert.equal(stamped.state, 'verified');
  assert.deepEqual(stamped.criteria, [
    { criterionId: 'c1', criterion: 'Correct result' },
    { criterionId: 'c2', criterion: 'Documented result' },
  ]);
  assert.deepEqual(stamped.criterionOutcomes, PASS_BOTH);
  // The period survives the stamp untouched.
  assert.deepEqual(stamped.period, f.receipt.period);
});

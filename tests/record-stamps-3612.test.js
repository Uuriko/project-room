// #3612 characterization: consequential records carry the five names +
// model version (accountability R-1(ii)/(iii), R-9).
//
// Per surface, following the bounty-rubrics test pattern:
// - board claims (pure kernel): claimWork stamps a server-derived
//   instance id + the claimant's declared runtime; recordReview stamps
//   the claim round's instance, the route-supplied principal, and the
//   reviewer's declared runtime onto the review record.
// - public-work: the finish receipt carries provenance {instance,
//   offer-creator principal, declared producer runtime}; review records
//   carry {instance, reviewer's principal, declared-or-platform runtime}.
// - bounty escrow: claim event, submission evidence, attestation and
//   settlement records carry the round's provenance.
// Anti-spoof pins: caller-supplied principal/session values are refused
// by the input shapes or overwritten by the server stamp — never stored
// as asserted. Declared runtimes are stored labelled source:"declared".
// New records only: nothing here asserts anything about stored history.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { createWork, claimWork, recordReview, workOf } from '../server/work-claims.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';
import { BountyEscrow } from '../server/bounty-escrow.mjs';
import { claimInstanceId, declaredRuntimeOf, runtimeStampOf, PLATFORM_RUNTIME } from '../server/record-stamps.mjs';

const NOW = '2026-10-18T00:00:00.000Z';
const code = expected => error => error.code === expected;

// --- record-stamps primitives -------------------------------------------

test('claimInstanceId is deterministic per round and differs across rounds', () => {
  const a = claimInstanceId('board', 'w1', 'alice', NOW);
  assert.equal(a, claimInstanceId('board', 'w1', 'alice', NOW));
  assert.match(a, /^inst_[0-9a-f]{24}$/);
  assert.notEqual(a, claimInstanceId('board', 'w1', 'alice', '2026-10-19T00:00:00.000Z'));
  assert.notEqual(a, claimInstanceId('board', 'w1', 'bob', NOW));
  assert.notEqual(a, claimInstanceId('bounty', 'w1', 'alice', NOW));
});

test('declaredRuntimeOf labels declarations and refuses malformed ones', () => {
  assert.deepEqual(declaredRuntimeOf({ model: 'model-x/1', harness: 'harness/2' }),
    { model: 'model-x/1', harness: 'harness/2', source: 'declared' });
  assert.deepEqual(declaredRuntimeOf({ model: 'model-x/1' }), { model: 'model-x/1', harness: null, source: 'declared' });
  assert.equal(declaredRuntimeOf(undefined), null);
  assert.throws(() => declaredRuntimeOf({}), /model or a harness/);
  assert.throws(() => declaredRuntimeOf({ model: 'x', principalMemberId: 'spoof' }), /only model and harness/);
  assert.throws(() => declaredRuntimeOf({ model: 42 }), /declaredRuntime\.model/);
  // A stored stamp keeps its label; an unlabelled runtime claim is dropped.
  assert.deepEqual(runtimeStampOf({ model: 'm', harness: null, source: 'declared' }), { model: 'm', harness: null, source: 'declared' });
  assert.equal(runtimeStampOf({ model: 'm', harness: 'h' }), null);
  assert.equal(PLATFORM_RUNTIME.source, 'platform');
});

// --- board claims (pure kernel) ------------------------------------------

test('board claim: claimWork stamps the server instance and the declared runtime', () => {
  const created = createWork({ id: 'w1' }, { now: NOW, agentId: 'coord' });
  assert.equal(created.instanceId ?? null, null, 'unclaimed work carries no instance stamp (sparse)');
  const claimed = claimWork(created, 'worker', { now: NOW, declaredRuntime: { model: 'model-x/1', harness: 'harness/2' } });
  assert.equal(claimed.instanceId, claimInstanceId('board', 'w1', 'worker', NOW));
  assert.deepEqual(claimed.producerRuntime, { model: 'model-x/1', harness: 'harness/2', source: 'declared' });
  // The stamps survive the storage normalizer.
  const roundTripped = workOf(JSON.parse(JSON.stringify(claimed)));
  assert.equal(roundTripped.instanceId, claimed.instanceId);
  assert.deepEqual(roundTripped.producerRuntime, claimed.producerRuntime);
});

test('board claim spoof: a stored fake instance/runtime is overwritten at claim time', () => {
  const created = createWork({ id: 'w2' }, { now: NOW, agentId: 'coord' });
  const poisoned = { ...created, instanceId: 'inst_000000000000000000000000',
    producerRuntime: { model: 'fake', harness: 'fake', source: 'platform' } };
  const claimed = claimWork(poisoned, 'worker', { now: NOW });
  assert.notEqual(claimed.instanceId, 'inst_000000000000000000000000');
  assert.equal(claimed.instanceId, claimInstanceId('board', 'w2', 'worker', NOW));
  assert.equal(claimed.producerRuntime ?? null, null, 'an undeclared round carries no producer runtime');
});

test('board claim review: recordReview stamps instance, principal, declared verifier runtime', () => {
  let item = claimWork(createWork({ id: 'w3' }, { now: NOW, agentId: 'coord' }), 'worker', { now: NOW });
  item = recordReview(item, 'reviewer', { verdict: 'approve', summary: 'checked it', now: NOW,
    stamps: { principalMemberId: 'human-reviewer', sessionInstanceId: 'inst_ffffffffffffffffffffffff',
      verifierRuntime: declaredRuntimeOf({ model: 'judge/1' }) } });
  const review = item.reviews.find(entry => entry.memberId === 'reviewer');
  assert.equal(review.provenance.sessionInstanceId, item.instanceId, 'the instance is the claim round, not the caller-supplied one');
  assert.notEqual(review.provenance.sessionInstanceId, 'inst_ffffffffffffffffffffffff');
  assert.equal(review.provenance.principalMemberId, 'human-reviewer');
  assert.deepEqual(review.provenance.verifierRuntime, { model: 'judge/1', harness: null, source: 'declared' });
  // And through the normalizer (storage round-trip).
  const stored = workOf(JSON.parse(JSON.stringify(item)));
  assert.deepEqual(stored.reviews[0].provenance, review.provenance);
});

// --- public-work receipts + reviews --------------------------------------

function publicFixture(t, mode = 'human') {
  // :memory: store — file-backed WAL stores fault in this VM window
  // (see STATE.md infra probe); the journey tests use the same form.
  const store = new RoomStore(':memory:');
  store.initialize(initialRoom());
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  const reviewers = mode === 'agent' ? ['reviewer'] : ['owner'];
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'stamp-task', reviewerMemberIds: reviewers,
    terms: { kind: 'task', title: 'Stamp this result', summary: 'Fixture', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
  store.projectOffers.transition('commons', 'owner', 'stamp-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'stamp-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  t.after(() => { store.close(); });
  return { store, producer };
}

test('public-work receipt: finish stamps instance, offer-creator principal, declared runtime', t => {
  const { store, producer } = publicFixture(t);
  store.publicWorkClaims.act('stamp-task', producer.secret, 'claim',
    { requestId: 'claim', expectedTermsVersion: 1, declaredRuntime: { model: 'claim-model/1' } });
  const item = store.workClaims.list(store.publicWorkClaims.read('stamp-task').namespaceId)
    .find(entry => entry.id === 'stamp-task');
  assert.match(item.instanceId, /^inst_[0-9a-f]{24}$/, 'the claim round itself is stamped at claim time');
  const receipt = store.publicWorkClaims.act('stamp-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['unit: pass'],
      declaredRuntime: { model: 'finish-model/2', harness: 'harness/3' } }).receipt;
  assert.equal(receipt.provenance.sessionInstanceId, item.instanceId);
  assert.equal(receipt.provenance.principalMemberId, 'owner', 'the offer creator is the authorizing principal');
  assert.deepEqual(receipt.provenance.producerRuntime, { model: 'finish-model/2', harness: 'harness/3', source: 'declared' });
  // Stored and re-read identically (new record only; no rewrite on read).
  assert.deepEqual(store.publicWorkClaims.receipt(receipt.receiptId).provenance, receipt.provenance);
});

test('public-work receipt: claim-time declaration carries to finish when finish declares none', t => {
  const { store, producer } = publicFixture(t);
  store.publicWorkClaims.act('stamp-task', producer.secret, 'claim',
    { requestId: 'claim', expectedTermsVersion: 1, declaredRuntime: { model: 'claim-model/1', harness: 'h/1' } });
  const receipt = store.publicWorkClaims.act('stamp-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: [] }).receipt;
  assert.deepEqual(receipt.provenance.producerRuntime, { model: 'claim-model/1', harness: 'h/1', source: 'declared' });
});

test('public-work spoof: caller-supplied principal/session keys are refused, never stamped', t => {
  const { store, producer } = publicFixture(t);
  store.publicWorkClaims.act('stamp-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  assert.throws(() => store.publicWorkClaims.act('stamp-task', producer.secret, 'finish',
    { requestId: 'finish-spoof', expectedTermsVersion: 1, generation: 1, artifactText: 'x', checksReported: [],
      principalMemberId: 'mallory', sessionInstanceId: 'inst_000000000000000000000000' }),
    code('invalid_public_work'));
  const receipt = store.publicWorkClaims.act('stamp-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'x', checksReported: [] }).receipt;
  assert.equal(receipt.provenance.principalMemberId, 'owner');
  assert.notEqual(receipt.provenance.sessionInstanceId, 'inst_000000000000000000000000');
});

test('public-work review: verify PASS stamps principal and the platform runtime; spoof keys refused', t => {
  const { store, producer } = publicFixture(t, 'agent');
  store.publicWorkClaims.act('stamp-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('stamp-task', producer.secret, 'finish',
    { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: [] }).receipt;
  const reviews = new PublicWorkReviews(store);
  const input = extra => ({ requestId: 'verify-1', expectedReviewRevision: 0, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'hashes match', verdict: 'PASS', ...extra });
  assert.throws(() => reviews.verify('commons', 'reviewer', receipt.receiptId, input({ principalMemberId: 'mallory' })),
    code('invalid_public_review'));
  const outcome = reviews.verify('commons', 'reviewer', receipt.receiptId, input());
  const verification = outcome.review.verification;
  assert.equal(verification.provenance.sessionInstanceId, receipt.provenance.sessionInstanceId);
  assert.equal(verification.provenance.principalMemberId, 'owner',
    'an agent reviewer with no accountable human stamps the room owner as its principal');
  assert.deepEqual(verification.provenance.verifierRuntime, PLATFORM_RUNTIME,
    'a PASS runs the platform artifact-integrity check, so the platform runtime is stamped');
});

// --- bounty escrow --------------------------------------------------------

const B_ROOM = 'room-stamps';
const POSTER = 'id:agent/poster';   // agent lane, accountable to a human
const WORKER = 'id:agent/worker';
const MEMBERS = {
  [POSTER]: { id: POSTER, kind: 'agent', active: true, accountableHumanId: 'human-poster' },
  [WORKER]: { id: WORKER, kind: 'agent', active: true, accountableHumanId: 'human-worker' },
};
let bountyNow = 1_786_000_000_000;
function bountyFixture() {
  const db = new DatabaseSync(':memory:');
  const transaction = fn => {
    db.exec('SAVEPOINT escrow_test');
    try { const out = fn(); db.exec('RELEASE escrow_test'); return out; }
    catch (error) { db.exec('ROLLBACK TO escrow_test'); db.exec('RELEASE escrow_test'); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction,
    roomAuthority: () => ({ ownerId: 'human-poster', members: MEMBERS }) };
  const escrow = new BountyEscrow(store, { now: () => bountyNow });
  escrow.ensureGenesis(B_ROOM);
  return { escrow, db };
}
const RUBRIC = [{ criterionId: 'correctness', description: 'the fix resolves the reported bug' }];
const bountyJourney = escrow => {
  const bounty = escrow.postBounty(B_ROOM, { poster: POSTER, title: 'T', criteria: 'C', amount: 10,
    deadline: new Date(bountyNow + 3_600_000).toISOString(), rubric: RUBRIC }).bounty;
  escrow.fundBounty(B_ROOM, bounty.bountyId, { funder: POSTER });
  return bounty;
};

test('bounty: claim, submission, attestation and settlement records carry the round provenance', () => {
  const { escrow } = bountyFixture();
  const bounty = bountyJourney(escrow);
  const claimed = escrow.claimBounty(B_ROOM, bounty.bountyId,
    { claimant: WORKER, declaredRuntime: { model: 'claim-model/1', harness: 'h/1' } });
  const claimProvenance = claimed.receipt.event.data.provenance;
  assert.match(claimProvenance.sessionInstanceId, /^inst_[0-9a-f]{24}$/);
  assert.equal(claimProvenance.sessionInstanceId,
    claimInstanceId('bounty', bounty.bountyId, WORKER, claimed.receipt.event.at));
  assert.equal(claimProvenance.principalMemberId, 'human-poster', 'the poster lane\'s accountable human');
  assert.deepEqual(claimProvenance.producerRuntime, { model: 'claim-model/1', harness: 'h/1', source: 'declared' });

  // Submission: a provenance key inside the caller's evidence is dropped
  // by _evidenceOf's field picking — the stored stamp is the server's,
  // and the claim-time declaration carries when finish declares none.
  const submitted = escrow.submitWork(B_ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: 'https://example.com/pr/1', summary: 'did the thing',
      provenance: { sessionInstanceId: 'inst_000000000000000000000000', principalMemberId: 'mallory' } } });
  assert.equal(submitted.bounty.evidence.provenance.sessionInstanceId, claimProvenance.sessionInstanceId);
  assert.equal(submitted.bounty.evidence.provenance.principalMemberId, 'human-poster');
  assert.deepEqual(submitted.bounty.evidence.provenance.producerRuntime, claimProvenance.producerRuntime);

  // Attestation: a provenance smuggled inside verifierAttestation is
  // overwritten by the server stamp placed after the spread.
  const accepted = escrow.acceptWork(B_ROOM, bounty.bountyId, { acceptor: POSTER,
    verifierAttestation: { at: new Date(bountyNow).toISOString(), note: 'lgtm',
      citations: [{ criterionId: 'correctness', verdict: 'pass' }],
      provenance: { sessionInstanceId: 'inst_000000000000000000000000', principalMemberId: 'mallory' } } });
  const attestation = accepted.bounty.attestation;
  assert.equal(attestation.provenance.sessionInstanceId, claimProvenance.sessionInstanceId);
  assert.equal(attestation.provenance.principalMemberId, 'human-poster');
  assert.equal(attestation.provenance.verifierRuntime, null, 'no declaration and no platform run: no verifier runtime is invented');
});

test('bounty: a rejected submission settles with the round provenance on the settlement record', () => {
  const { escrow } = bountyFixture();
  const bounty = bountyJourney(escrow);
  const claimed = escrow.claimBounty(B_ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(B_ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: 'https://example.com/pr/2', summary: 'attempt' } });
  const rejected = escrow.rejectWork(B_ROOM, bounty.bountyId, { rejector: POSTER, reason: 'does not meet the criteria' });
  const settlement = rejected.bounty.resolution.settlement;
  assert.equal(settlement.kind, 'failed');
  assert.equal(settlement.provenance.sessionInstanceId, claimed.receipt.event.data.provenance.sessionInstanceId);
  assert.equal(settlement.provenance.principalMemberId, 'human-poster');
});

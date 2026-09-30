import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { PublicWorkReviews, publicWorkReviewsSchema } from '../server/public-work-reviews.mjs';

// Real persisted offers, identities, public claim kernel and immutable receipts.
// Registration/HTTP/workerd owners separately qualify bootstrap and transport.
function fixture(t, mode = 'human', linked = false) {
  const dir = mkdtempSync(join(tmpdir(), 'public-review-')), file = join(dir, 'room.sqlite');
  let store = new RoomStore(file);
  store.initialize(initialRoom()); store.initialize(initialRoom('other-room'));
  store.db.exec(publicWorkReviewsSchema);
  const producer = store.identities.create('Producer'), other = store.identities.create('Other');
  const state = store.room('commons').state;
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'agent', active: true, displayName: 'Reviewer', permissions: ['read', 'verify'] };
  state.members.stranger = { id: 'stranger', revision: 1, kind: 'human', active: true, displayName: 'Other human', permissions: ['read', 'decide', 'verify'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  if (linked === 'human') { state.members.reviewer.kind = 'human'; store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons'); }
  if (linked) store.command(store.issueAccessKey('commons', 'owner'), 'commons', { id: 'propose-linked-work', type: 'work.proposed', data: { workItemId: 'linked-work', title: 'Linked work', definitionOfDone: 'Exact independently reviewed result', accountableMemberId: 'owner', verifierMemberId: 'reviewer', independentVerificationRequired: true, ownerDecisionRequired: true, humanDecisionMakerId: 'owner', mode: 'write' } });
  const reviewers = mode === 'human' ? (linked ? ['owner', 'reviewer'] : ['owner']) : mode === 'agent' ? ['reviewer'] : ['owner', 'reviewer'];
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'review-task', reviewerMemberIds: reviewers, ...(linked ? { workItemId: 'linked-work' } : {}),
    terms: { kind: 'task', title: 'Review this result', summary: 'Explicit feedback', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project', reward: { kind: 'unpaid' }, approvalPolicy: { mode } } });
  store.projectOffers.transition('commons', 'owner', 'review-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'review-task', { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  store.publicWorkClaims.act('review-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('review-task', producer.secret, 'finish', { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: '<not-html>🐈', checksReported: ['Caller reports success'] }).receipt;
  const service = () => new PublicWorkReviews(store);
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { get store() { return store; }, service, receipt, producer, other, file,
    alter(fn) { const state = store.room('commons').state; fn(state); store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons'); },
    reopen() { store.close(); store = new RoomStore(file); },
    input(requestId, revision = 0, extra = {}) { return { requestId, expectedReviewRevision: revision, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact', ...extra }; } };
}
const code = expected => error => error.code === expected;

test('owner results retain withdrawn receipts, exact decisions persist, artifact/kernel/balances remain unchanged', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  const artifact = f.store.publicWorkClaims.artifact(id), kernel = f.store.publicWorkClaims.read('review-task');
  const balances = f.store.db.prepare('SELECT * FROM bounty_journal ORDER BY seq').all();
  f.store.projectOffers.transition('commons', 'owner', 'review-task', 'withdraw', { requestId: 'withdraw', expectedRevision: 2 });
  const initial = f.service().results('commons', 'owner').results[0];
  assert.equal(initial.offer.status, 'withdrawn'); assert.equal(initial.review.revision, 0); assert.equal(initial.authority.acceptReady, true);
  assert.throws(() => f.service().results('commons', 'stranger'), code('owner_only'));
  const args = f.input('accept', 0, { decision: 'accepted' });
  const accepted = f.service().decide('commons', 'owner', id, args);
  assert.equal(accepted.review.state, 'accepted'); assert.equal(accepted.review.revision, 1);
  assert.equal(accepted.authority.canDecide, false);
  f.reopen(); assert.deepEqual(f.service().decide('commons', 'owner', id, args), accepted);
  assert.deepEqual(f.store.publicWorkClaims.receipt(id), f.receipt);
  assert.deepEqual(f.store.publicWorkClaims.artifact(id), artifact);
  assert.equal(f.store.workClaims.get(kernel.namespaceId, kernel.taskId).state, 'done');
  assert.deepEqual(f.store.db.prepare('SELECT * FROM bounty_journal ORDER BY seq').all(), balances);
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('late-reject', 1, { decision: 'rejected' })), code('review_final'));
  assert.throws(() => f.service().decide('commons', 'owner', id, { ...args, reason: 'Changed' }), code('request_id_reused'));
});

test('CAS, exact tuple and room isolation refuse stale or unauthorized decisions without writes', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  assert.throws(() => f.service().inspect('other-room', 'owner', id), code('review_not_found'));
  assert.throws(() => f.service().inspect('commons', 'stranger', id), code('review_forbidden'));
  assert.throws(() => f.service().decide('commons', 'stranger', id, f.input('wrong-reviewer', 0, { decision: 'accepted' })), code('review_forbidden'));
  for (const binding of [{ taskId: 'wrong-task' }, { expectedTermsVersion: 2 }, { generation: 2 }, { artifactSha256: '0'.repeat(64) }])
    assert.throws(() => f.service().decide('commons', 'owner', id, f.input('bad-tuple', 0, { decision: 'accepted', ...binding })), code('stale_review_receipt'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_reviews').get().n, 0);
  const concurrent = new RoomStore(f.file);
  const otherService = new PublicWorkReviews(concurrent);
  assert.equal(otherService.inspect('commons', 'owner', id).review.revision, 0);
  f.service().decide('commons', 'owner', id, f.input('first', 0, { decision: 'revision_requested' }));
  try { assert.throws(() => otherService.decide('commons', 'owner', id, f.input('other-connection', 0, { decision: 'rejected' })), code('stale_review')); } finally { concurrent.close(); }
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('concurrent', 0, { decision: 'accepted' })), code('stale_review'));
  assert.equal(f.service().decide('commons', 'owner', id, f.input('explicit-after-revision', 1, { decision: 'accepted' })).review.revision, 2);
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'submitted');
});

test('mixed acceptance requires real authorized exact-current PASS and survives restart', t => {
  const f = fixture(t, 'human_with_agent_review'), id = f.receipt.receiptId;
  assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, false);
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('too-early', 0, { decision: 'accepted' })), code('review_pass_required'));
  assert.throws(() => f.service().verify('commons', 'owner', id, f.input('fake-owner-pass', 0, { verdict: 'PASS' })), code('review_forbidden'));
  assert.equal(f.service().inspect('commons', 'reviewer', id).authority.canVerify, true);
  assert.throws(() => f.service().results('commons', 'reviewer'), code('owner_only'));
  f.service().verify('commons', 'reviewer', id, f.input('agent-pass', 0, { verdict: 'PASS' }));
  f.reopen(); assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, true);
  f.alter(state => { state.members.reviewer.revision += 1; state.members.reviewer.permissions = ['read']; });
  assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, false);
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('stale-agent-pass', 1, { decision: 'accepted' })), code('review_pass_required'));
  f.alter(state => { state.members.reviewer.revision += 1; state.members.reviewer.permissions = ['read', 'verify']; });
  assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, false);
  f.service().verify('commons', 'reviewer', id, f.input('fresh-agent-pass', 1, { verdict: 'PASS' }));
  assert.equal(f.service().decide('commons', 'owner', id, f.input('human-accept', 2, { decision: 'accepted' })).review.state, 'accepted');
});

test('agent approval requires actual PASS and current human-required policies prohibit it', t => {
  const f = fixture(t, 'agent'), id = f.receipt.receiptId;
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('owner-agent', 0, { decision: 'accepted' })), code('review_forbidden'));
  assert.throws(() => f.service().decide('commons', 'reviewer', id, f.input('agent-no-pass', 0, { decision: 'accepted' })), code('review_pass_required'));
  f.service().verify('commons', 'reviewer', id, f.input('agent-pass', 0, { verdict: 'PASS' }));
  f.alter(state => { state.room.policy = { requireOwnerDecision: true }; });
  assert.throws(() => f.service().decide('commons', 'reviewer', id, f.input('new-human-policy', 1, { decision: 'accepted' })), code('review_forbidden'));
  f.alter(state => { state.room.policy = { requireOwnerDecision: false }; });
  assert.equal(f.service().decide('commons', 'reviewer', id, f.input('agent-accept', 1, { decision: 'accepted' })).review.state, 'accepted');
});

test('linked identity alias cannot review own submission and revoked owner cannot replay', t => {
  const f = fixture(t, 'agent'), id = f.receipt.receiptId;
  f.store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', f.producer.identityId, 'reviewer', Date.now());
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('self-pass', 0, { verdict: 'PASS' })), code('review_forbidden'));
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n, 0);
  const human = fixture(t), args = human.input('owner-accepted', 0, { decision: 'accepted' });
  human.service().decide('commons', 'owner', human.receipt.receiptId, args);
  human.alter(state => { state.members.owner.active = false; });
  assert.throws(() => human.service().decide('commons', 'owner', human.receipt.receiptId, args), code('review_forbidden'));
});

test('outside producer sees only own sanitized feedback without membership or private reviewer facts', t => {
  const f = fixture(t, 'human_with_agent_review'), id = f.receipt.receiptId;
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM identity_links').get().n, 0);
  const before = f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n;
  assert.equal(f.service().contributorReview(f.producer.secret, id).review.state, 'pending');
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n, before);
  f.service().verify('commons', 'reviewer', id, f.input('agent-fail', 0, { verdict: 'FAIL', reason: 'Private review evidence' }));
  f.service().decide('commons', 'owner', id, f.input('feedback', 1, { decision: 'revision_requested', reason: 'Please fix the missing test' }));
  const own = f.service().contributorReview(f.producer.secret, id);
  assert.equal(own.review.reason, 'Please fix the missing test'); assert.equal(own.review.verificationVerdict, 'FAIL');
  for (const forbidden of ['roomId', 'owner', 'reviewer', 'fingerprint', 'Private review evidence', 'reviewerMemberIds', 'workItemId']) assert.equal(JSON.stringify(own).includes(forbidden), false);
  assert.throws(() => f.service().contributorReview(f.other.secret, id), code('review_not_found'));
  f.store.db.prepare('UPDATE agent_identities SET revoked_at=? WHERE identity_id=?').run(Date.now(), f.producer.identityId);
  assert.throws(() => f.service().contributorReview(f.producer.secret, id), code('unauthenticated'));
});

test('linked-work evidence revision and designated verifier gates invalidate earlier PASS', t => {
  const f = fixture(t, 'human_with_agent_review', true), id = f.receipt.receiptId;
  f.service().verify('commons', 'reviewer', id, f.input('first-pass', 0, { verdict: 'PASS' }));
  assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, true);
  f.store.command(f.store.issueAccessKey('commons', 'owner'), 'commons', { id: 'accept-linked', type: 'work.accepted', data: { workItemId: 'linked-work', expectedRevision: 0 } });
  assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, false);
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('old-work-pass', 1, { decision: 'accepted' })), code('review_pass_required'));
  f.service().verify('commons', 'reviewer', id, f.input('new-work-pass', 1, { verdict: 'PASS' }));
  f.alter(state => { state.workItems['linked-work'].verifierMemberId = 'owner'; });
  assert.throws(() => f.service().verify('commons', 'reviewer', id, f.input('wrong-designated', 2, { verdict: 'PASS' })), code('review_forbidden'));
  assert.throws(() => f.service().decide('commons', 'owner', id, f.input('changed-designated', 2, { decision: 'accepted' })), code('review_pass_required'));
  assert.equal(f.store.publicWorkClaims.receipt(id).state, 'submitted');
});

test('review action namespace cannot alias verification journal and invalid input never burns a request', t => {
  const f = fixture(t, 'agent'), id = f.receipt.receiptId;
  const args = f.input('same-id', 0, { verdict: 'PASS' });
  f.service().verify('commons', 'reviewer', id, args);
  assert.throws(() => f.service().decide('commons', 'reviewer', id, f.input('same-id', 1, { decision: 'accepted' })), code('request_id_reused'));
  assert.throws(() => f.service().decide('commons', 'reviewer', id, f.input('fixable', 1, { decision: 'accepted', unexpected: true })), code('invalid_public_review'));
  assert.equal(f.service().decide('commons', 'reviewer', id, f.input('fixable', 1, { decision: 'accepted' })).review.state, 'accepted');
});

test('historical readonly receipts remain inspectable as pending without installing review tables', t => {
  const f = fixture(t), id = f.receipt.receiptId;
  f.store.db.exec('DROP TABLE public_work_reviews; DROP TABLE public_work_review_requests;');
  const readonly = new RoomStore(f.file, { readOnly: true });
  try {
    const service = new PublicWorkReviews(readonly);
    assert.equal(service.verifySchema({ allowAbsent: true }), false);
    assert.equal(service.results('commons', 'owner').results[0].review.state, 'pending');
    assert.equal(service.contributorReview(f.producer.secret, id).review.state, 'pending');
    assert.equal(readonly.db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name LIKE 'public_work_review%'").get().n, 0);
  } finally { readonly.close(); }
});

test('journal failure rolls back review revision and exact request remains retryable', t => {
  const f = fixture(t), id = f.receipt.receiptId, args = f.input('durable-accept', 0, { decision: 'accepted' });
  f.store.db.exec("CREATE TRIGGER fail_review_journal BEFORE INSERT ON public_work_review_requests BEGIN SELECT RAISE(ABORT,'test journal unavailable'); END;");
  assert.throws(() => f.service().decide('commons', 'owner', id, args), /test journal unavailable/);
  assert.equal(f.service().inspect('commons', 'owner', id).review.revision, 0);
  assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM public_work_review_requests').get().n, 0);
  f.store.db.exec('DROP TRIGGER fail_review_journal;');
  assert.equal(f.service().decide('commons', 'owner', id, args).review.state, 'accepted');
});

test('Human-mode independent verification records human evidence without implying an AI check', t => {
  const f = fixture(t, 'human', 'human'), id = f.receipt.receiptId;
  assert.equal(f.service().inspect('commons', 'owner', id).authority.acceptReady, false);
  const verified = f.service().verify('commons', 'reviewer', id, f.input('human-check', 0, { verdict: 'PASS' }));
  assert.equal(verified.review.verification.reviewerKind, 'human');
  assert.equal(Object.hasOwn(verified.review, 'agentReview'), false);
  assert.equal(f.service().decide('commons', 'owner', id, f.input('human-decision', 1, { decision: 'accepted' })).review.state, 'accepted');
  const feedback = f.service().contributorReview(f.producer.secret, id);
  assert.equal(feedback.review.verificationVerdict, 'PASS');
  assert.equal(feedback.review.verificationReviewerKind, 'human');
  assert.equal(Object.hasOwn(feedback.review, 'agentVerdict'), false);
});

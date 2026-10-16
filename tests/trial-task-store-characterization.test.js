// Characterization owner for server/trial-task-store.mjs STORE-level semantics
// (E6, decision #11 prep). The pure state machine is pinned by
// tests/trial-tasks.test.js and the HTTP surface by
// tests/trial-task-http.test.js; this suite pins what neither covers: the
// store's resting states, revision/idempotency journal behavior, list
// privacy, vetting-key configuration, and the verdict gate composition —
// the exact seams a lifecycle merge (or a cluster park) must preserve.
// Real RoomStore + SQLite + production crypto; no test seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { addRailMember } from '../scripts/record-rails-fixture.mjs';
import { generateReceiptKeyPair, issueVettingReceipt } from '../server/vetting-receipts.mjs';

function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'trial-char-'));
  const store = new RoomStore(join(dir, 'room.sqlite'));
  store.initialize(initialRoom());
  store.initialize(initialRoom('other-room'));
  addRailMember(store, 'worker');
  addRailMember(store, 'buyer2');
  addRailMember(store, 'bystander');
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return store;
}

const CREATE = {
  action: 'create', candidateId: 'worker', buyerId: 'owner', demigodReqId: 'req-1',
  title: 'Characterization trial', trialScope: { hoursMax: '40', deliverableShape: 'code-pr' },
  vettingRubric: [{ criterion: 'c1', weightBps: '10000' }], feePolicyRef: 'demigod-placement/1',
};
const create = (store, over = {}) =>
  store.trialTasks.apply('commons', 'owner', { ...CREATE, requestId: 'create-1', taskId: 'trial-1', ...over });
const apply = (store, actor, input) => store.trialTasks.apply('commons', actor, input);

// Drive a funded task to submitted (create carries a budgetRecord, so it
// rests at funded/revision 0; claim -> revision 1; submit -> revision 2).
function submitted(store, taskId = 'trial-1') {
  create(store, { taskId, requestId: `create-${taskId}`, budgetRecord: { note: 'Recorded budget' } });
  apply(store, 'worker', { action: 'claim', requestId: `claim-${taskId}`, taskId, expectedRevision: 0 });
  return apply(store, 'worker', { action: 'submit', requestId: `submit-${taskId}`, taskId, expectedRevision: 1, deliverableRef: 'https://example.com/delivery' });
}

// Full verdict gate: configure the evaluator key, run a buyer signoff loop
// to accepted, then apply the verdict with a bound signed receipt.
function receipted(store, { taskId = 'trial-1', verdict = 'pass' } = {}) {
  const task = submitted(store, taskId);
  const keys = generateReceiptKeyPair();
  apply(store, 'owner', { action: 'configure', requestId: `key-${taskId}`, expectedRevision: 0, pubkey: keys.pubkeyHex });
  store.buyerSignoff.create('commons', 'owner', { requestId: `loop-${taskId}`, loopId: `loop-${taskId}`, trialTaskId: taskId, buyerId: 'owner', maxRounds: 2 });
  store.buyerSignoff.submit('commons', 'worker', `loop-${taskId}`, { requestId: `delivery-${taskId}`, candidateId: 'worker', deliverableRef: task.deliverableRef, sha256: 'a'.repeat(64), summary: 'Delivery' });
  store.buyerSignoff.review('commons', 'owner', `loop-${taskId}`, { requestId: `review-${taskId}`, decision: 'accept' });
  const rubricScores = [{ criterion: 'c1', scoreBps: '10000' }];
  const receipt = issueVettingReceipt({
    trialTaskId: taskId, demigodReqId: task.demigodReqId, candidateId: 'worker', scope: task.trialScope,
    rubricScores, verdict, evaluator: { kind: 'human', id: 'owner' },
    issuedAt: new Date(store.now()).toISOString(), now: store.now(),
  }, keys);
  const result = apply(store, 'owner', { action: 'verdict', requestId: `verdict-${taskId}`, taskId, expectedRevision: 2, rubricScores, verdict, receipt });
  return { task: result, receipt };
}

test('store lifecycle rests at each state and bumps revision once per apply', (t) => {
  const store = fixture(t);
  const proposed = create(store);
  assert.equal(proposed.state, 'proposed');
  assert.equal(proposed.revision, 0);
  const funded = apply(store, 'owner', { action: 'fund', requestId: 'fund-1', taskId: 'trial-1', expectedRevision: 0, budgetRecord: { note: 'Recorded later' } });
  assert.equal(funded.state, 'funded');
  assert.equal(funded.revision, 1);
  assert.equal(funded.budgetRecord.recordedBy, 'owner');
  const claimed = apply(store, 'worker', { action: 'claim', requestId: 'claim-1', taskId: 'trial-1', expectedRevision: 1 });
  assert.equal(claimed.state, 'claimed');
  assert.equal(claimed.candidateId, 'worker');
  const submittedTask = apply(store, 'worker', { action: 'submit', requestId: 'submit-1', taskId: 'trial-1', expectedRevision: 2, deliverableRef: 'https://example.com/d' });
  assert.equal(submittedTask.state, 'submitted');
  assert.equal(submittedTask.revision, 3);
  assert.deepEqual(submittedTask.history.map(h => h.to), ['proposed', 'funded', 'claimed', 'submitted']);
});

test('create with a budgetRecord rests at funded directly (no separate fund step)', (t) => {
  const store = fixture(t);
  const task = create(store, { budgetRecord: { note: 'Up front' } });
  assert.equal(task.state, 'funded');
  assert.equal(task.revision, 0);
  assert.equal(task.recordOnly, true);
  assert.equal(task.paymentStatus, 'not_configured');
});

test('verdict is never a resting state: one verdict apply lands on receipted', (t) => {
  const store = fixture(t);
  const { task, receipt } = receipted(store);
  assert.equal(task.state, 'receipted');
  assert.equal(task.verdict, 'pass');
  assert.equal(task.receiptRef, receipt.receiptId);
  assert.deepEqual(task.history.map(h => h.to), ['proposed', 'funded', 'claimed', 'submitted', 'verdict', 'receipted']);
  assert.equal(store.trialTasks.verified('commons', 'trial-1', receipt.receiptId).id, 'trial-1');
});

test('a failed verdict still receipts, but verified() refuses it', (t) => {
  const store = fixture(t);
  const { task, receipt } = receipted(store, { verdict: 'fail' });
  assert.equal(task.state, 'receipted');
  assert.equal(task.verdict, 'fail');
  assert.throws(() => store.trialTasks.verified('commons', 'trial-1', receipt.receiptId), { code: 'verified_receipt_required' });
});

test('verified() refuses unreceipted tasks and mismatched receipt ids', (t) => {
  const store = fixture(t);
  submitted(store);
  assert.throws(() => store.trialTasks.verified('commons', 'trial-1', 'some-receipt'), { code: 'verified_receipt_required' });
  const { receipt } = receipted(store, { taskId: 'trial-2' });
  assert.throws(() => store.trialTasks.verified('commons', 'trial-2', 'not-the-receipt'), { code: 'verified_receipt_required' });
  assert.equal(store.trialTasks.verified('commons', 'trial-2', receipt.receiptId).state, 'receipted');
});

test('a second verdict apply on a receipted task is a stale revision, not a replay', (t) => {
  const store = fixture(t);
  const { receipt } = receipted(store);
  assert.throws(
    () => apply(store, 'owner', { action: 'verdict', requestId: 'verdict-again', taskId: 'trial-1', expectedRevision: 2, rubricScores: [{ criterion: 'c1', scoreBps: '10000' }], verdict: 'pass', receipt }),
    { code: 'stale_revision' },
  );
});

test('block parks with blockedFrom, resume restores and drops the reason, release is terminal', (t) => {
  const store = fixture(t);
  create(store, { budgetRecord: { note: 'n' } });
  apply(store, 'worker', { action: 'claim', requestId: 'claim-1', taskId: 'trial-1', expectedRevision: 0 });
  const blocked = apply(store, 'owner', { action: 'block', requestId: 'block-1', taskId: 'trial-1', expectedRevision: 1, reason: 'waiting on buyer' });
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.blockedFrom, 'claimed');
  assert.equal(blocked.blockReason, 'waiting on buyer');
  const resumed = apply(store, 'owner', { action: 'resume', requestId: 'resume-1', taskId: 'trial-1', expectedRevision: 2 });
  assert.equal(resumed.state, 'claimed');
  assert.equal(resumed.blockedFrom, null);
  assert.equal('blockReason' in resumed, false);
  assert.deepEqual(resumed.history.map(h => h.to), ['proposed', 'funded', 'claimed', 'blocked', 'claimed']);
  const released = apply(store, 'owner', { action: 'release', requestId: 'release-1', taskId: 'trial-1', expectedRevision: 3, reason: 'cancelled' });
  assert.equal(released.state, 'released');
  assert.throws(
    () => apply(store, 'worker', { action: 'claim', requestId: 'claim-2', taskId: 'trial-1', expectedRevision: 4 }),
    (err) => err.code === 'illegal_transition' || err.code === 'stale_revision',
  );
});

test('list() shows each party only its own trials; the owner sees all', (t) => {
  const store = fixture(t);
  create(store, { budgetRecord: { note: 'n' } });
  create(store, { requestId: 'create-2', taskId: 'trial-2', candidateId: 'bystander', buyerId: 'buyer2', budgetRecord: { note: 'n' } });
  const ids = (actor) => store.trialTasks.list('commons', actor).tasks.map(x => x.id).sort();
  assert.deepEqual(ids('owner'), ['trial-1', 'trial-2']);
  assert.deepEqual(ids('worker'), ['trial-1']);
  assert.deepEqual(ids('buyer2'), ['trial-2']);
  assert.deepEqual(ids('bystander'), ['trial-2']);
  addRailMember(store, 'stranger');
  assert.deepEqual(ids('stranger'), []);
});

test('configure rotates the vetting key by revision and refuses cross-room key reuse', (t) => {
  const store = fixture(t);
  const k1 = generateReceiptKeyPair(), k2 = generateReceiptKeyPair();
  const first = apply(store, 'owner', { action: 'configure', requestId: 'cfg-1', expectedRevision: 0, pubkey: k1.pubkeyHex });
  assert.equal(first.revision, 1);
  // Exact replay returns the recorded outcome without rotating again.
  assert.deepEqual(apply(store, 'owner', { action: 'configure', requestId: 'cfg-1', expectedRevision: 0, pubkey: k1.pubkeyHex }), first);
  assert.throws(
    () => apply(store, 'owner', { action: 'configure', requestId: 'cfg-2', expectedRevision: 0, pubkey: k2.pubkeyHex }),
    { code: 'stale_revision' },
  );
  const rotated = apply(store, 'owner', { action: 'configure', requestId: 'cfg-2', expectedRevision: 1, pubkey: k2.pubkeyHex });
  assert.equal(rotated.revision, 2);
  assert.equal(rotated.pubkey, k2.pubkeyHex);
  // The same key may not issuer-bind a second room.
  assert.throws(
    () => store.trialTasks.apply('other-room', 'owner', { action: 'configure', requestId: 'cfg-other', expectedRevision: 0, pubkey: k2.pubkeyHex }),
    { code: 'receipt_key_already_bound' },
  );
});

test('request journal: replay returns the original outcome; reuse with new input or actor conflicts', (t) => {
  const store = fixture(t);
  create(store, { budgetRecord: { note: 'n' } });
  const claimInput = { action: 'claim', requestId: 'claim-1', taskId: 'trial-1', expectedRevision: 0 };
  const claimed = apply(store, 'worker', claimInput);
  apply(store, 'worker', { action: 'submit', requestId: 'submit-1', taskId: 'trial-1', expectedRevision: 1, deliverableRef: 'https://example.com/d' });
  // Replay after the task advanced: the recorded claim outcome comes back
  // verbatim and nothing re-applies.
  const replay = apply(store, 'worker', claimInput);
  assert.deepEqual(replay, claimed);
  assert.equal(store.trialTasks.raw('commons', 'trial-1').state, 'submitted');
  assert.throws(() => apply(store, 'worker', { ...claimInput, expectedRevision: 9 }), { code: 'request_id_reused' });
  assert.throws(() => apply(store, 'owner', claimInput), { code: 'request_id_reused' });
});

test('party binding: transitions refuse non-parties with trial_not_party', (t) => {
  const store = fixture(t);
  create(store, { budgetRecord: { note: 'n' } });
  // Buyer is not the bound candidate: cannot claim or submit.
  assert.throws(() => apply(store, 'owner', { action: 'claim', requestId: 'c-x', taskId: 'trial-1', expectedRevision: 0 }), { code: 'trial_not_party' });
  apply(store, 'worker', { action: 'claim', requestId: 'c-1', taskId: 'trial-1', expectedRevision: 0 });
  assert.throws(() => apply(store, 'owner', { action: 'submit', requestId: 's-x', taskId: 'trial-1', expectedRevision: 1, deliverableRef: 'https://example.com/d' }), { code: 'trial_not_party' });
  // The candidate is neither owner nor buyer: cannot fund, block, or release.
  const store2Task = create(store, { requestId: 'create-9', taskId: 'trial-9' });
  assert.equal(store2Task.state, 'proposed');
  assert.throws(() => apply(store, 'worker', { action: 'fund', requestId: 'f-x', taskId: 'trial-9', expectedRevision: 0, budgetRecord: { note: 'n' } }), { code: 'trial_not_party' });
  assert.throws(() => apply(store, 'worker', { action: 'release', requestId: 'r-x', taskId: 'trial-1', expectedRevision: 1 }), { code: 'trial_not_party' });
});

test('create refuses prototype-named or identical parties', (t) => {
  const store = fixture(t);
  assert.throws(() => create(store, { candidateId: 'constructor' }), { code: 'invalid_trial_party' });
  assert.throws(() => create(store, { candidateId: '__proto__' }), { code: 'invalid_trial_party' });
  assert.throws(() => create(store, { requestId: 'create-same', taskId: 'trial-same', candidateId: 'worker', buyerId: 'worker' }), { code: 'invalid_trial_party' });
  assert.throws(() => create(store, { requestId: 'create-ghost', taskId: 'trial-ghost', candidateId: 'never-added' }), { code: 'invalid_trial_party' });
});

test('railActor rejects prototype-named ids while real members pass (#3224 slice 4)', (t) => {
  const store = fixture(t);
  // members["toString"] on the plain room projection resolves
  // Object.prototype.toString — a truthy phantom that raw indexing treated
  // as an active member. Resolved through ownMember it is absent, so the
  // rail gate must refuse it (trial-task-store.mjs railActor).
  for (const phantom of ['toString', 'constructor', 'hasOwnProperty']) {
    assert.throws(() => store.trialTasks.list('commons', phantom), { code: 'access_denied' });
  }
  // A real member still passes the same gate.
  assert.deepEqual(store.trialTasks.list('commons', 'owner'), { tasks: [] });
});

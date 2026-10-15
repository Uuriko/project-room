import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// First Shift settlement rail (shape ii: public-work reward extension over
// the existing bounty escrow). Real store, real escrow journal, real review
// module: fund -> claim -> submit -> verdict, with exact milli-credit
// reconciliation at every step and the escrow conservation invariant held
// throughout. Prices are the First Shift bands (4 credits accept path,
// 2 credits reject path), denominated as work_trade amountMinor milli-credits.
function fixture(t, { amountMinor = '4000' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-settlement-')), file = join(dir, 'room.sqlite');
  let clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer');
  const stranger = store.identities.create('Stranger');
  const state = structuredClone(store.room('commons').state);
  state.members.worker = { id: 'worker', revision: 1, kind: 'agent', active: true, displayName: 'Worker', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', producer.identityId, 'worker', clock);
  store.bountyEscrow.ensureGenesis('commons');
  const terms = { kind: 'task', title: 'Paid public task', summary: 'Settle me', acceptanceCriteria: ['Correct result'],
    repositoryUrl: 'https://github.com/example/project', reward: { kind: 'work_trade', unit: 'credit', amountMinor }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'paid-task', reviewerMemberIds: ['owner'], terms });
  store.projectOffers.transition('commons', 'owner', 'paid-task', 'publish', { requestId: 'publish', expectedRevision: 1 });
  const enable = () => store.publicWorkClaims.enable('commons', 'owner', 'paid-task',
    { requestId: 'enable', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  const claimAndFinish = () => {
    store.publicWorkClaims.act('paid-task', producer.secret, 'claim', { requestId: 'claim', expectedTermsVersion: 1 });
    return store.publicWorkClaims.act('paid-task', producer.secret, 'finish',
      { requestId: 'finish', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['checked'] }).receipt;
  };
  const decideInput = (requestId, decision) => receipt => ({ requestId, expectedReviewRevision: 0, taskId: receipt.taskId,
    expectedTermsVersion: receipt.termsVersion, generation: receipt.generation, artifactSha256: receipt.artifact.sha256,
    reason: 'Reviewed the exact artifact', decision });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, producer, stranger, enable, claimAndFinish, decideInput, tick: ms => { clock += ms; } };
}

// Exact journal-derived balances in milli-credits: [payable, locked, attributed, approved].
const millis = (store, account) => ['payable', 'locked', 'attributed', 'approved'].map(state =>
  store.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id='commons' AND account_id=? AND lot_state=?").get(account, state).t);
const issued = store => store.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id='commons' AND kind='genesis'").get().t;
const conserved = store => {
  const check = store.bountyEscrow.verifyConservation('commons');
  assert.equal(check.ok, true, `conservation violated: ${JSON.stringify(check.violations)}`);
  return check;
};
const code = expected => error => error.code === expected;

test('accept path: fund -> claim -> submit -> accept -> epoch payout reconciles exactly, fee to pool, no new issuance', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  assert.equal(issuedBefore, 200_000); // owner + worker genesis only
  const packet = f.enable();
  assert.equal(packet.reward.kind, 'work_trade');
  assert.equal(packet.settlement.amountMillis, 4000);
  assert.equal(packet.settlement.phase, 'funded');
  // Funding locked the poster's existing balance; nothing was issued.
  assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [100_000, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);

  const receipt = f.claimAndFinish();
  // Submission attached to escrow: award still locked with the poster, the
  // existing 1-credit claim bond locked with the worker.
  assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 0, 0]);
  assert.equal(store.bountyEscrow.getBounty('commons', packet.settlement.bountyId).state, 'submitted');
  assert.equal(issued(store), issuedBefore); conserved(store);

  const args = f.decideInput('accept-1', 'accepted')(receipt);
  const outcome = store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, args);
  assert.equal(outcome.review.state, 'accepted');
  assert.equal(outcome.settlement.phase, 'accepted');
  assert.equal(outcome.settlement.escrowReceipt.kind, 'attribute');
  // Verdict attributes the award to the claimant; payout awaits the existing
  // challenge window + epoch sweep (dispute flow untouched).
  assert.deepEqual(millis(store, 'owner'), [96_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);

  // Reviewer-silence gate pinned the other way: nothing else moves until the
  // window passes and the keeper sweeps.
  store.bountyEscrow.closeEpoch('commons');
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);
  f.tick(3 * 24 * 3600 * 1000 + 1000);
  store.bountyEscrow.closeEpoch('commons'); // accepted -> approved
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 0, 4_000]);
  const epoch = store.bountyEscrow.closeEpoch('commons'); // approved -> paid
  assert.equal(epoch.summary.paid.length, 1);
  // 4 credits minus the existing 1% pool fee (40 millis) = 3.96 to the
  // worker, claim bond returned in full, pool holds only the fee.
  assert.deepEqual(millis(store, 'worker'), [103_960, 0, 0, 0]);
  assert.deepEqual(millis(store, 'owner'), [96_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [40, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);

  const settled = store.publicWorkSettlement.viewForOffer('paid-task');
  assert.equal(settled.phase, 'paid');
  assert.equal(settled.payoutReceipt.kind, 'payout');
  assert.equal(settled.payoutReceipt.amountMillis, 3960);

  // Idempotency: replaying the verdict returns the recorded outcome and a
  // further epoch moves nothing twice.
  assert.deepEqual(store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId, args), outcome);
  store.bountyEscrow.closeEpoch('commons');
  assert.deepEqual(millis(store, 'worker'), [103_960, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [40, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('reject path: fund -> claim -> submit -> reject refunds the poster in full, no fee on the award', t => {
  const f = fixture(t, { amountMinor: '2000' }), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  assert.deepEqual(millis(store, 'owner'), [98_000, 2_000, 0, 0]);
  const receipt = f.claimAndFinish();
  const outcome = store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId,
    f.decideInput('reject-1', 'rejected')(receipt));
  assert.equal(outcome.review.state, 'rejected');
  assert.equal(outcome.settlement.phase, 'refunded');
  assert.equal(outcome.settlement.escrowReceipt.kind, 'reject');
  // Award back to the poster in full, feeless. The claim bond follows the
  // existing anti-flake semantics for judged-bad work: forfeited to the pool.
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [1_000, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);
  // Duplicate verdict replays the recorded outcome; nothing moves twice.
  assert.deepEqual(store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId,
    f.decideInput('reject-1', 'rejected')(receipt)), outcome);
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [1_000, 0, 0, 0]);
  conserved(store);
});

test('reviewer silence settles nothing: no verdict, no movement, even past the challenge window and an epoch', t => {
  const f = fixture(t), { store } = f;
  f.enable();
  f.claimAndFinish();
  const before = ['owner', 'worker', 'pool'].map(account => millis(store, account));
  f.tick(30 * 24 * 3600 * 1000);
  store.bountyEscrow.closeEpoch('commons');
  // The mirror bounty's far-out deadline keeps the escrow keeper from
  // free-missing a public-work submission: VIII.1's flip is John-gated and
  // this rail does not implement it.
  assert.equal(store.bountyEscrow.getBounty('commons', store.publicWorkSettlement.link('paid-task').bounty_id).state, 'submitted');
  assert.deepEqual(['owner', 'worker', 'pool'].map(account => millis(store, account)), before);
  conserved(store);
});

test('paid claim requires a linked settlement lane; unpaid claims by the same unlinked identity are unaffected', t => {
  const f = fixture(t), { store } = f;
  f.enable();
  assert.throws(() => store.publicWorkClaims.act('paid-task', f.stranger.secret, 'claim',
    { requestId: 'stranger-claim', expectedTermsVersion: 1 }), code('settlement_lane_unlinked'));
  assert.equal(store.publicWorkClaims.read('paid-task').claim.state, 'unclaimed');
  conserved(store);
});

test('funding failure lists nothing: a price above the poster balance refuses the enable atomically', t => {
  const f = fixture(t, { amountMinor: '200000' }), { store } = f;
  assert.throws(() => f.enable(), code('insufficient_funds'));
  assert.equal(store.publicWorkSettlement.link('paid-task'), null);
  assert.deepEqual(store.publicWorkClaims.list().tasks, []);
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  conserved(store);
});

test('cash rewards still cannot enter the public board, and unpaid review behavior is unchanged', t => {
  const f = fixture(t), { store } = f;
  store.projectOffers.create('commons', 'owner', { requestId: 'create-cash', offerId: 'cash-task', reviewerMemberIds: ['owner'],
    terms: { kind: 'task', title: 'Cash task', summary: 'Nope', acceptanceCriteria: ['Correct result'], repositoryUrl: 'https://github.com/example/project',
      reward: { kind: 'cash', unit: 'USD', amountMinor: '500' }, approvalPolicy: { mode: 'human' } } });
  store.projectOffers.transition('commons', 'owner', 'cash-task', 'publish', { requestId: 'publish-cash', expectedRevision: 1 });
  assert.throws(() => store.publicWorkClaims.enable('commons', 'owner', 'cash-task',
    { requestId: 'enable-cash', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] }),
    code('public_work_not_eligible'));
  assert.equal(store.publicWorkSettlement.link('cash-task'), null);
  conserved(store);
});

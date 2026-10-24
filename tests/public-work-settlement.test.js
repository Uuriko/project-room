import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { publicWorkRewardMillis } from '../server/public-work-settlement.mjs';

// First Shift settlement rail (shape ii: public-work reward extension over
// the existing bounty escrow). Real store, real escrow journal, real review
// module: fund -> claim -> submit -> verdict, with exact milli-credit
// reconciliation at every step and the escrow conservation invariant held
// throughout. Prices are the First Shift bands (4 credits accept path,
// 2 credits reject path), denominated as work_trade amountMinor milli-credits.
// The direct import above also satisfies the untested-server-module gate
// (scripts/untested-modules-lint.mjs) for the new module: the reward
// classifier is pinned directly below, not only through the store flows.
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

test('reward classifier: only a positive in-cap work_trade credit price is a paid task', () => {
  // Unpaid shapes read as null (no settlement); anything that is not a
  // well-formed credit price reads as undefined (refused at enable time).
  assert.equal(publicWorkRewardMillis(null), null);
  assert.equal(publicWorkRewardMillis({}), null);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'unpaid' } }), null);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: '4000' } }), 4000);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: '1000000000' } }), 1_000_000_000); // MAX_CREDITS * MILLIS_PER_CREDIT
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: '1000000001' } }), undefined); // above the cap
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: '0' } }), undefined);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: '-5' } }), undefined);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: '4.5' } }), undefined);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'credit', amountMinor: 'abc' } }), undefined);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'work_trade', unit: 'USD', amountMinor: '4000' } }), undefined);
  assert.equal(publicWorkRewardMillis({ reward: { kind: 'cash', unit: 'USD', amountMinor: '500' } }), undefined);
});

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

// Mutation-testing lane 2026-10-16 (B1): the two pins below close survivor
// holes found by anchored mutation of server/public-work-settlement.mjs.

test('attach: a second, different receipt is refused and the first binding stands', t => {
  // Kills PS-05 (already-attached refusal removed from attachSubmission).
  // Without the refusal the call falls through to the escrow, which happens
  // to refuse the second claim too — but with the wrong error, after doing
  // escrow work inside the finish transaction. The rail's own 409 is the
  // contract: settlement_already_attached, and the first binding untouched.
  const f = fixture(t), { store } = f;
  f.enable();
  const receipt = f.claimAndFinish();
  const before = store.publicWorkSettlement.link('paid-task');
  assert.equal(before.receipt_id, receipt.receiptId);
  // Control: re-attaching the SAME receipt is the idempotent path (a view).
  assert.ok(store.publicWorkSettlement.attachSubmission('commons', 'paid-task', receipt));
  assert.throws(() => store.publicWorkSettlement.attachSubmission('commons', 'paid-task',
    { ...receipt, receiptId: 'pwr_forged_second_submission' }), code('settlement_already_attached'));
  const after = store.publicWorkSettlement.link('paid-task');
  assert.equal(after.receipt_id, receipt.receiptId);
  assert.equal(after.claimant_lane, before.claimant_lane);
  conserved(store);
});

test('settle: a funded task with no attached submission cannot be settled', t => {
  // Kills PS-06 (not-submitted leg removed from settleOnVerdict). Without
  // it the call falls through to the escrow, which refuses with its own
  // invalid_state; the rail's settlement_not_submitted is the refusal the
  // review surface keys on, and it must fire for both verdicts.
  const f = fixture(t), { store } = f;
  f.enable(); // funded, but nobody has claimed or finished
  assert.throws(() => store.publicWorkSettlement.settleOnVerdict('commons', 'paid-task', { decision: 'accepted', reason: 'premature' }),
    code('settlement_not_submitted'));
  assert.throws(() => store.publicWorkSettlement.settleOnVerdict('commons', 'paid-task', { decision: 'rejected', reason: 'premature' }),
    code('settlement_not_submitted'));
  conserved(store);
});

test('claimable gate: the poster cannot claim their own paid task on the rail', t => {
  // Kills PS-04 (poster leg removed from the rail's assertClaimable). The
  // escrow refuses a poster self-claim as well, but only at claim time
  // inside the escrow; the rail's own 403 is what stops the poster before
  // a public-work claim record is created.
  const f = fixture(t), { store } = f;
  const ownerIdentity = store.identities.create('Owen');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', ownerIdentity.identityId, 'owner', store.now());
  f.enable();
  assert.throws(() => store.publicWorkSettlement.assertClaimable('commons', 'paid-task', ownerIdentity.identityId),
    code('public_work_not_owner'));
  // Control: the linked worker identity is claimable.
  assert.equal(store.publicWorkSettlement.assertClaimable('commons', 'paid-task', f.producer.identityId), 'worker');
  conserved(store);
});

test('claimable gate: a probation-band lane is refused above the probation cap on the rail', t => {
  // Kills PS-09 (probation leg removed from the rail's assertClaimable).
  // The escrow enforces the same gate inside claimBounty; the rail checks
  // first so a paid-task claim fails with the rail's own refusal before any
  // escrow state moves. Repeated claim flakes (-6 each, 30-day half-life)
  // put the worker lane in the probation band (score < -20); each flake
  // also starts a 7-day claim cooldown, so the clock steps a week between
  // flakes — six flakes land near -27, clear of the threshold. An 8-credit
  // task is above the 5-credit probation cap; a 4-credit task is not
  // (control).
  const f = fixture(t, { amountMinor: '8000' }), { store } = f;
  const escrow = store.bountyEscrow;
  for (let i = 0; i < 6; i++) {
    const { bounty } = escrow.postBounty('commons',
      { poster: 'owner', title: `flake ${i}`, criteria: 'C', amount: 8, deadline: new Date(store.now() + 3_600_000).toISOString() });
    escrow.fundBounty('commons', bounty.bountyId, { funder: 'owner' });
    escrow.claimBounty('commons', bounty.bountyId, { claimant: 'worker' });
    f.tick(3_600_000 + 1);
    assert.equal(escrow.finalizeBounty('commons', bounty.bountyId, { caller: 'owner' }).action, 'refunded');
    f.tick(7 * 24 * 3_600_000);
  }
  f.enable();
  assert.throws(() => store.publicWorkSettlement.assertClaimable('commons', 'paid-task', f.producer.identityId),
    code('reputation_probation'));
  // Control: at 4 credits the same probation lane is claimable (never a ban).
  const terms = { kind: 'task', title: 'Small paid task', summary: 'Settle me', acceptanceCriteria: ['Correct result'],
    repositoryUrl: 'https://github.com/example/project', reward: { kind: 'work_trade', unit: 'credit', amountMinor: '4000' }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'create-small', offerId: 'small-task', reviewerMemberIds: ['owner'], terms });
  store.projectOffers.transition('commons', 'owner', 'small-task', 'publish', { requestId: 'publish-small', expectedRevision: 1 });
  store.publicWorkClaims.enable('commons', 'owner', 'small-task',
    { requestId: 'enable-small', expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: ['result.txt'] });
  assert.equal(store.publicWorkSettlement.assertClaimable('commons', 'small-task', f.producer.identityId), 'worker');
  conserved(store);
});
// BUILD-W31-C specimens — append to tests/public-work-settlement.test.js
// F5 + F6 for issue #3907. Drafted 2026-10-21 during write-fault episode;
// append verbatim once the worktree exists, run fail-first at base head.

test('payout view: the payout movement is named by its lot id, never as a receipt id (#3907 F5)', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  const receipt = f.claimAndFinish();
  const outcome = store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId,
    f.decideInput('accept-f5', 'accepted')(receipt));
  assert.equal(outcome.settlement.phase, 'accepted');
  store.bountyEscrow.closeEpoch('commons');
  f.tick(3 * 24 * 3600 * 1000 + 1000);
  store.bountyEscrow.closeEpoch('commons'); // accepted -> approved
  store.bountyEscrow.closeEpoch('commons'); // approved -> paid
  const settled = store.publicWorkSettlement.viewForOffer('paid-task');
  assert.equal(settled.phase, 'paid');
  assert.equal(settled.payoutReceipt.kind, 'payout');
  // F5: escrow history's receiptId IS a lot id (first.lot_id ?? first.entry_id).
  // The settlement view must name it lotId; a field called receiptId carrying
  // a lot_… value can never match bounty_journal.receipt_id.
  assert.equal('receiptId' in settled.payoutReceipt, false);
  assert.match(settled.payoutReceipt.lotId, /^lot_/);
  // The actual signed payout receipt ids ride in signedReceiptIds; none of
  // them is the lot id. Ruling 39 (2026-10-21): this fixture configures no
  // receipt signer, so the derived set is legitimately empty here — the pin
  // is asserted over the derived set as it stands (no signed receipt id
  // equals the lot id), not as a non-emptiness precondition.
  for (const id of settled.payoutReceipt.signedReceiptIds) {
    assert.match(id, /^room-bounty-receipt:/);
    assert.notEqual(id, settled.payoutReceipt.lotId);
  }
  // Settlement totals before/after are exactly the accept path's: the rename
  // moves no money. Worker 100_000 genesis + 3_960 net (4_000 minus the 1%
  // pool fee of 40), bond returned; pool holds only the fee.
  assert.equal(settled.payoutReceipt.amountMillis, 3960);
  assert.deepEqual(millis(store, 'worker'), [103_960, 0, 0, 0]);
  assert.deepEqual(millis(store, 'owner'), [96_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [40, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('lane pin: a mid-claim identity re-link does not move the settlement lane (#3907 F6)', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  assert.equal(issuedBefore, 200_000); // owner + worker genesis only
  f.enable();
  // Settlement totals before the claim: poster locked the 4-credit price.
  assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [100_000, 0, 0, 0]);
  // Claim under the producer identity while it is linked to member 'worker':
  // the claim-time gates run for lane 'worker', and that lane is pinned.
  store.publicWorkClaims.act('paid-task', f.producer.secret, 'claim',
    { requestId: 'claim-f6', expectedTermsVersion: 1 });
  assert.equal(store.publicWorkSettlement.link('paid-task').claimant_lane, 'worker');
  // A second member joins; genesis funds its lane so a finish under the
  // re-linked lane COULD settle there (the divergence is executable, not an
  // incidental refusal).
  const state = structuredClone(store.room('commons').state);
  state.members.worker2 = { id: 'worker2', revision: 1, kind: 'agent', active: true, displayName: 'Worker Two', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.bountyEscrow.ensureGenesis('commons');
  assert.deepEqual(millis(store, 'worker2'), [100_000, 0, 0, 0]);
  // Re-link the claimant identity from 'worker' to 'worker2' mid-claim.
  store.db.prepare('DELETE FROM identity_links WHERE room_id=? AND identity_id=?').run('commons', f.producer.identityId);
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', f.producer.identityId, 'worker2', store.now());
  assert.equal(store.publicWorkSettlement.laneForIdentity('commons', f.producer.identityId), 'worker2');
  // Finish as the same identity. The finish must attach under the pinned
  // claim-time lane: worker's bond locks, worker2 is untouched.
  const receipt = store.publicWorkClaims.act('paid-task', f.producer.secret, 'finish',
    { requestId: 'finish-f6', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['checked'] }).receipt;
  const link = store.publicWorkSettlement.link('paid-task');
  assert.equal(link.claimant_lane, 'worker');
  assert.equal(store.bountyEscrow.getBounty('commons', link.bounty_id).claimant, 'worker');
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 0, 0]);
  assert.deepEqual(millis(store, 'worker2'), [100_000, 0, 0, 0]);
  conserved(store);
  // Accept and sweep: the payout lands on the pinned lane exactly as the
  // honest path (3_960 net to worker, 40 fee to pool); worker2 never moves.
  const outcome = store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId,
    f.decideInput('accept-f6', 'accepted')(receipt));
  assert.equal(outcome.settlement.claimantLane, 'worker');
  store.bountyEscrow.closeEpoch('commons');
  f.tick(3 * 24 * 3600 * 1000 + 1000);
  store.bountyEscrow.closeEpoch('commons');
  store.bountyEscrow.closeEpoch('commons');
  assert.equal(store.publicWorkSettlement.viewForOffer('paid-task').phase, 'paid');
  assert.deepEqual(millis(store, 'worker'), [103_960, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker2'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [40, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore + 100_000); conserved(store);
});

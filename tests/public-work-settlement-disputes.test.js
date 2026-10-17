import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';

// #3702 / #3703: disputes on settlement-rail bounties. The rail designates
// the offer's first non-poster named reviewer as the escrow bounty's
// dispute decider at fund time, so a dispute can actually be decided; the
// challenge window bounds disputes on accepted bounties; and a dispute
// that reaches the 14-day timeout default forfeits the challenger's bond
// to the pool — the bond never compensates the claimant on a no-verdict
// settlement, which is what made a confederate dispute a money pump.
// Exact milli-credit reconciliation at every step, conservation held
// throughout. Prices are the First Shift M band (4 credits, 25% dispute
// bond = 1 credit).
function fixture(t, { amountMinor = '4000' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'public-settlement-disputes-')), file = join(dir, 'room.sqlite');
  let clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.worker = { id: 'worker', revision: 1, kind: 'agent', active: true, displayName: 'Worker', permissions: ['read'] };
  state.members.reviewer = { id: 'reviewer', revision: 1, kind: 'human', active: true, displayName: 'Reviewer', permissions: ['read', 'decide'] };
  state.members.reviewer2 = { id: 'reviewer2', revision: 1, kind: 'human', active: true, displayName: 'Reviewer Two', permissions: ['read', 'decide'] };
  state.members.rival = { id: 'rival', revision: 1, kind: 'agent', active: true, displayName: 'Rival', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', producer.identityId, 'worker', clock);
  store.bountyEscrow.ensureGenesis('commons');
  const terms = { kind: 'task', title: 'Paid public task', summary: 'Settle me', acceptanceCriteria: ['Correct result'],
    repositoryUrl: 'https://github.com/example/project', reward: { kind: 'work_trade', unit: 'credit', amountMinor }, approvalPolicy: { mode: 'human' } };
  store.projectOffers.create('commons', 'owner', { requestId: 'create', offerId: 'paid-task', reviewerMemberIds: ['reviewer', 'reviewer2'], terms });
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
  return { store, producer, enable, claimAndFinish, decideInput, tick: ms => { clock += ms; } };
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
const bountyOf = store => store.bountyEscrow.getBounty('commons', store.publicWorkSettlement.link('paid-task').bounty_id);

test('fund designates the first non-poster named reviewer as the dispute decider', t => {
  const f = fixture(t), { store } = f;
  const packet = f.enable();
  assert.equal(packet.settlement.disputeDecider, 'reviewer');
  assert.equal(bountyOf(store).disputeDecider, 'reviewer');
  assert.equal(bountyOf(store).verifier, null); // the work-verifier office stays empty in human mode
  conserved(store);
});

test('dispute on accepted work is decidable: the seated decider rules and the pump pays nothing extra', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  const receipt = f.claimAndFinish();
  assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 0, 0]);

  // Option A (#3726): disputes open only on accepted work, so the
  // confederate's route now runs through an acceptance first — a
  // colluding rota seat accepts the junk, and the award moves to the
  // worker as attributed.
  const outcome = store.publicWorkReviews.decide('commons', 'reviewer2', receipt.receiptId,
    f.decideInput('colluding-accept', 'accepted')(receipt));
  assert.equal(outcome.settlement.phase, 'accepted');
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);

  // The confederate disputes the accepted bounty for exactly 25%.
  const { dispute } = store.bountyEscrow.disputeBounty('commons', bountyOf(store).bountyId,
    { challenger: 'rival', bond: 1, grounds: 'junk artifact' });
  assert.equal(dispute.decider, 'reviewer');
  assert.equal(dispute.unavailable, null);
  assert.equal(dispute.state, 'adjudicating');
  assert.deepEqual(millis(store, 'rival'), [99_000, 1_000, 0, 0]);
  assert.equal(bountyOf(store).state, 'disputed');
  conserved(store);

  // While disputed, settlement is frozen out: the keeper cannot
  // finalize the bounty, and an epoch sweep lands nothing — the
  // accepted award stays attributed and unpaid until the dispute
  // resolves. (Pre-Option-A this freeze surfaced at the rota decide
  // itself, the receipt still being undecided; on accepted work the
  // verdict is already in, so the freeze binds the settlement path.)
  assert.throws(() => store.bountyEscrow.finalizeBounty('commons', bountyOf(store).bountyId, {}), code('invalid_state'));
  store.bountyEscrow.closeEpoch('commons');
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);
  assert.equal(bountyOf(store).state, 'disputed');
  conserved(store);

  // The seated decider rules the challenge upheld: the award refunds to
  // the poster in full, the challenger's bond returns (they were right),
  // and the claimant's claim bond follows the judged-bad forfeiture.
  const ruled = store.bountyEscrow.decideDispute('commons', bountyOf(store).bountyId,
    { decider: 'reviewer', outcome: 'upheld', reasonCodes: ['criterion-unmet'] });
  assert.equal(ruled.bounty.state, 'refunded');
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'rival'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [1_000, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('the designated decider cannot dispute into their own seat (party-as-judge): refused before the bond locks (#3727 × #3866)', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  const receipt = f.claimAndFinish();
  // Option A (#3726): disputes open only on accepted work, so the
  // scenario sits behind an acceptance; the seating refusal below is
  // the pin (#3866) as composed with #3770's refuse-at-open.
  store.publicWorkReviews.decide('commons', 'reviewer2', receipt.receiptId,
    f.decideInput('rota-accept', 'accepted')(receipt));
  // The rail designated 'reviewer' (a human member) as the dispute decider
  // at fund time. The reviewer raises a dispute against the very bounty
  // they would judge: seating reports the designee unavailable — they
  // are the challenger (party-as-judge, #3866's signal) — and #3770
  // refuses the dispute at open on that signal. The record never
  // exists, no seat is granted, and the bond never locks.
  assert.throws(() => store.bountyEscrow.disputeBounty('commons', bountyOf(store).bountyId,
    { challenger: 'reviewer', bond: 1, grounds: 'judging my own challenge' }), code('dispute_unavailable'));
  assert.deepEqual(millis(store, 'reviewer'), [100_000, 0, 0, 0]);
  assert.equal(bountyOf(store).state, 'accepted');
  assert.equal(bountyOf(store).disputeId, null);
  // Nothing exists for the reviewer — or anyone — to rule on.
  assert.throws(() => store.bountyEscrow.decideDispute('commons', bountyOf(store).bountyId,
    { decider: 'reviewer', outcome: 'upheld', reasonCodes: ['criterion-unmet'] }), code('invalid_state'));
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('a designated decider who is no longer an active member cannot be seated: refused before the bond locks (#3727)', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  const receipt = f.claimAndFinish();
  store.publicWorkReviews.decide('commons', 'reviewer', receipt.receiptId,
    f.decideInput('honest-accept', 'accepted')(receipt));
  assert.equal(bountyOf(store).disputeDecider, 'reviewer');
  // The designated decider leaves the room (membership deactivated)
  // between designation and dispute. Lane cards enumerate agent
  // members, and the human-decider path seats only a LIVE member — an
  // inactive designee produces no card, seating reports unavailable,
  // and the dispute refuses at open: the challenger's bond never locks
  // and the bounty is never frozen into an undecidable record.
  const state = structuredClone(store.room('commons').state);
  state.members.reviewer.active = false;
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  assert.throws(() => store.bountyEscrow.disputeBounty('commons', bountyOf(store).bountyId,
    { challenger: 'rival', bond: 1, grounds: 'the judge has left' }), code('dispute_unavailable'));
  assert.deepEqual(millis(store, 'rival'), [100_000, 0, 0, 0]);
  assert.equal(bountyOf(store).state, 'accepted');
  assert.equal(bountyOf(store).disputeId, null);
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('undecided dispute timeout on accepted work: award vests, but the challenger bond goes to the pool, never the claimant', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  const receipt = f.claimAndFinish();
  // Option A (#3726): the dispute opens on ACCEPTED work — the rota
  // accepts first, so when the timeout default later releases the
  // award, the vesting is the honest accept path's gain, not a pump:
  // acceptance is what makes the worker's entitlement legitimate.
  store.publicWorkReviews.decide('commons', 'reviewer', receipt.receiptId,
    f.decideInput('honest-accept', 'accepted')(receipt));
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);
  const { dispute } = store.bountyEscrow.disputeBounty('commons', bountyOf(store).bountyId,
    { challenger: 'rival', bond: 1, grounds: 'stall the verdict' });
  assert.equal(dispute.decider, 'reviewer');

  // The decider never rules; past 14 days the keeper defaults to RELEASE.
  f.tick(15 * 24 * 3600 * 1000);
  const { action } = store.bountyEscrow.finalizeBounty('commons', bountyOf(store).bountyId, {});
  assert.equal(action, 'released');
  const settled = bountyOf(store);
  assert.equal(settled.resolution.kind, 'release');
  assert.equal(settled.resolution.outcome, 'timeout-default');
  // The award vests with the worker (approved, exactly where the honest
  // accept path leaves it), but the 1-credit dispute bond is in the
  // POOL — the worker's balances show no trace of it, and the
  // challenger does not get it back either (the projector scores the
  // timeout as the challenger's loss).
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 0, 4_000]);
  assert.deepEqual(millis(store, 'rival'), [99_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [1_000, 0, 0, 0]);
  conserved(store);

  // Epoch sweep pays the award minus the 1% fee and returns the claim
  // bond; the worker's total gain is exactly the honest accept path's.
  store.bountyEscrow.closeEpoch('commons');
  assert.deepEqual(millis(store, 'worker'), [103_960, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [1_040, 0, 0, 0]);
  assert.deepEqual(millis(store, 'owner'), [96_000, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('sponsor protection works: a dispute inside the window can claw back a colluding accept (#3703)', t => {
  const f = fixture(t), { store } = f;
  const issuedBefore = issued(store);
  f.enable();
  const receipt = f.claimAndFinish();
  // A colluding rota seat accepts the junk.
  const outcome = store.publicWorkReviews.decide('commons', 'reviewer2', receipt.receiptId,
    f.decideInput('colluding-accept', 'accepted')(receipt));
  assert.equal(outcome.settlement.phase, 'accepted');
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);

  // The sponsor disputes inside the 3-day challenge window.
  const { dispute } = store.bountyEscrow.disputeBounty('commons', bountyOf(store).bountyId,
    { challenger: 'owner', bond: 1, grounds: 'accepted without review' });
  assert.equal(dispute.decider, 'reviewer');
  assert.deepEqual(millis(store, 'owner'), [95_000, 1_000, 0, 0]);
  conserved(store);

  // The designated decider upholds: the sponsor is made whole — award
  // refunded, own bond returned — and the worker's claim bond is
  // forfeited as judged-bad. The protective dispute is no longer
  // strictly negative-EV.
  const ruled = store.bountyEscrow.decideDispute('commons', bountyOf(store).bountyId,
    { decider: 'reviewer', outcome: 'upheld', reasonCodes: ['criterion-unmet'] });
  assert.equal(ruled.bounty.state, 'refunded');
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'pool'), [1_000, 0, 0, 0]);
  assert.equal(issued(store), issuedBefore); conserved(store);
});

test('a dispute filed after the challenge window closes is refused (#3703)', t => {
  const f = fixture(t), { store } = f;
  f.enable();
  const receipt = f.claimAndFinish();
  store.publicWorkReviews.decide('commons', 'reviewer', receipt.receiptId,
    f.decideInput('honest-accept', 'accepted')(receipt));
  // 1ms past the 3-day challenge window: the payout is the keeper's to
  // approve, and a late dispute can no longer freeze it.
  f.tick(3 * 24 * 3600 * 1000 + 1);
  assert.throws(() => store.bountyEscrow.disputeBounty('commons', bountyOf(store).bountyId,
    { challenger: 'rival', bond: 1, grounds: 'too late' }), code('invalid_state'));
  assert.deepEqual(millis(store, 'rival'), [100_000, 0, 0, 0]);
  conserved(store);
});

test('escrow designation contract: decider is any third-party member; the verifier office is unchanged', t => {
  const f = fixture(t), { store } = f;
  const escrow = store.bountyEscrow;
  const deadline = new Date(store.now() + 3600 * 1000).toISOString();
  const post = overrides => escrow.postBounty('commons',
    { poster: 'owner', title: 'T', criteria: 'C', amount: 4, deadline, ...overrides }).bounty;
  // A human member may be designated dispute decider.
  assert.equal(post({ disputeDeciderId: 'reviewer' }).disputeDecider, 'reviewer');
  // Never the poster, never a phantom.
  assert.throws(() => post({ disputeDeciderId: 'owner' }), code('invalid_input'));
  assert.throws(() => post({ disputeDeciderId: 'nobody' }), code('not_authorized'));
  // The designated VERIFIER office keeps its agent-only contract.
  assert.throws(() => post({ verifierId: 'reviewer' }), code('invalid_input'));
  assert.equal(post({ verifierId: 'worker' }).verifier, 'worker');
  conserved(store);
});

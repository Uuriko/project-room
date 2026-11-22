import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { progressEscrowEpochs, escrowEpochNextDueAt } from '../server/bounty-epoch-keeper.mjs';

// CURE-MIRROR-REVIEW-EXEMPTION (specimen S3, money-core deep-dive 2026-10-25):
// a public-work mirror bounty carries a fixed 365-day placeholder deadline.
// Before this cure, a submitted mirror bounty at/after that deadline was a
// pure ordering race — keeper-first refunded it `unverified` (poster whole,
// worker 0), verdict-first attributed the worker in full — because neither
// _keeperPass nor the epoch due-scan had a pending-review exemption, while
// acceptWork has no deadline guard. The cure picks the exemption side (see
// DECISION.md in the wave lane / the PR body): the keeper never free-misses
// a mirror bounty whose review is still pending, and the due-scan agrees,
// so a verdict is honoured whenever it lands and both orderings resolve to
// the same rule-determined outcome. Fixture mirrors
// tests/public-work-settlement.test.js (real store, real rail, fake clock).
const DAY_MS = 24 * 3600 * 1000;
const MIRROR_DEADLINE_MS = 365 * DAY_MS;

function fixture(t, { amountMinor = '4000' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'mirror-exemption-')), file = join(dir, 'room.sqlite');
  const T0 = Date.parse('2027-03-01T00:00:00.000Z');
  let clock = T0;
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer');
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
  const decide = receipt => store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId,
    { requestId: 'accept-1', expectedReviewRevision: 0, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Reviewed the exact artifact', decision: 'accepted' });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, enable, claimAndFinish, decide, T0, setClock: ms => { clock = ms; }, tick: ms => { clock += ms; } };
}

const millis = (store, account) => ['payable', 'locked', 'attributed', 'approved'].map(state =>
  store.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id='commons' AND account_id=? AND lot_state=?").get(account, state).t);
const conserved = store => assert.equal(store.bountyEscrow.verifyConservation('commons').ok, true);
const mirrorBounty = store => store.bountyEscrow.getBounty('commons', store.publicWorkSettlement.link('paid-task').bounty_id);
const EMPTY_KEEPER = { rooms: 0, due: 0, approved: 0, paid: 0, refunded: 0, released: 0, expired: 0, failed: 0, errors: 0, overdue: 0 };

test('keeper-first at/after the mirror deadline: no free-miss, no due count, verdict still honoured in full', t => {
  const f = fixture(t), { store } = f;
  f.enable();
  const receipt = f.claimAndFinish();
  assert.equal(mirrorBounty(store).state, 'submitted');
  assert.equal(mirrorBounty(store).deadlineMs, f.T0 + MIRROR_DEADLINE_MS);

  for (const instant of [f.T0 + MIRROR_DEADLINE_MS, f.T0 + MIRROR_DEADLINE_MS + 1]) {
    f.setClock(instant);
    // The epoch due-scan does not count the exempt bounty as due or overdue,
    // and offers no next-due wake for it.
    assert.deepEqual(progressEscrowEpochs(store, { now: instant }), EMPTY_KEEPER);
    assert.equal(escrowEpochNextDueAt(store, instant), null);
    // closeEpoch and finalizeBounty both leave it untouched.
    const epoch = store.bountyEscrow.closeEpoch('commons');
    assert.deepEqual(epoch.summary.refunded, []);
    assert.throws(() => store.bountyEscrow.finalizeBounty('commons', mirrorBounty(store).bountyId, { caller: 'owner' }),
      error => error.code === 'invalid_state');
    assert.equal(mirrorBounty(store).state, 'submitted');
    assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
    assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 0, 0]);
    conserved(store);
  }

  // The verdict lands after the deadline and is honoured exactly as if it
  // had landed before it — the keeper-first ordering no longer pre-empts it.
  const outcome = f.decide(receipt);
  assert.equal(outcome.review.state, 'accepted');
  assert.equal(outcome.settlement.phase, 'accepted');
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);
  // And the accepted award then pays out through the normal challenge sweep.
  f.tick(3 * DAY_MS + 1000);
  store.bountyEscrow.closeEpoch('commons'); // accepted -> approved
  const epoch = store.bountyEscrow.closeEpoch('commons'); // approved -> paid
  assert.equal(epoch.summary.paid.length, 1);
  assert.deepEqual(millis(store, 'worker'), [103_960, 0, 0, 0]); // 4 credits - 1% fee, bond home
  assert.deepEqual(millis(store, 'pool'), [40, 0, 0, 0]);
  conserved(store);
});

test('verdict-first at/after the mirror deadline resolves to the same outcome as keeper-first', t => {
  const f = fixture(t), { store } = f;
  f.enable();
  const receipt = f.claimAndFinish();
  f.setClock(f.T0 + MIRROR_DEADLINE_MS + 1);
  const outcome = f.decide(receipt);
  assert.equal(outcome.settlement.phase, 'accepted');
  assert.equal(mirrorBounty(store).state, 'accepted');
  assert.deepEqual(millis(store, 'owner'), [96_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [99_000, 1_000, 4_000, 0]);
  assert.deepEqual(progressEscrowEpochs(store, { now: f.T0 + MIRROR_DEADLINE_MS + 1 }), EMPTY_KEEPER);
  conserved(store);
});

test('a mirror bounty with no submission (no pending review) still refunds at its deadline', t => {
  const f = fixture(t), { store } = f;
  const packet = f.enable(); // funded, never claimed or submitted
  assert.equal(packet.settlement.phase, 'funded');
  f.setClock(f.T0 + MIRROR_DEADLINE_MS);
  const epoch = store.bountyEscrow.closeEpoch('commons');
  assert.deepEqual(epoch.summary.refunded, [packet.settlement.bountyId]);
  assert.equal(mirrorBounty(store).state, 'refunded');
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]); // poster whole, feeless
  conserved(store);
});

test('a mirror bounty whose review is already terminal is not exempt: the free-miss proceeds', t => {
  const f = fixture(t), { store } = f;
  f.enable();
  const receipt = f.claimAndFinish();
  // A terminal verdict recorded WITHOUT the bounty leaving `submitted` is
  // reachable only by writing past the review module (whose verdict and
  // bounty transition commit in one transaction). The exemption keys on a
  // genuinely pending review, so it falls away here.
  store.db.prepare('INSERT INTO public_work_reviews VALUES (?,?,?,?)')
    .run(receipt.receiptId, 'commons', 1, JSON.stringify({ revision: 1, state: 'accepted', decision: null }));
  f.setClock(f.T0 + MIRROR_DEADLINE_MS + 1);
  const epoch = store.bountyEscrow.closeEpoch('commons');
  assert.deepEqual(epoch.summary.refunded, [mirrorBounty(store).bountyId]);
  assert.equal(mirrorBounty(store).state, 'refunded');
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [100_000, 0, 0, 0]); // bond home, award 0 (unverified terms)
  conserved(store);
});

test('a non-mirror submitted bounty is unaffected: past its deadline the keeper free-misses it as before', t => {
  const f = fixture(t), { store } = f;
  const escrow = store.bountyEscrow;
  const bounty = escrow.postBounty('commons',
    { poster: 'owner', title: 'Ordinary', criteria: 'C', amount: 4, deadline: new Date(f.T0 + 3600_000).toISOString() }).bounty;
  escrow.fundBounty('commons', bounty.bountyId, { funder: 'owner' });
  escrow.claimBounty('commons', bounty.bountyId, { claimant: 'worker' });
  escrow.submitWork('commons', bounty.bountyId, { claimant: 'worker',
    evidence: { evidenceUrl: 'https://example.com/pr/1', summary: 'did the thing' } });
  assert.equal(escrow.getBounty('commons', bounty.bountyId).state, 'submitted');
  f.setClock(f.T0 + 3600_000); // exactly at the deadline
  const keeper = progressEscrowEpochs(store, { now: f.T0 + 3600_000 });
  assert.equal(keeper.due, 1);
  assert.equal(keeper.refunded, 1);
  assert.equal(escrow.getBounty('commons', bounty.bountyId).state, 'refunded');
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  assert.deepEqual(millis(store, 'worker'), [100_000, 0, 0, 0]);
  conserved(store);
});

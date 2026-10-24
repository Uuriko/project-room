import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RoomStore } from '../server/store.mjs';
import { initialRoom } from '../server/bootstrap.mjs';
import { publicWorkExposure, sponsorRoomCapMillisOf } from '../server/public-work-settlement.mjs';

// COMP-DEEP #23 (PRE-FIRST-SHIFT launch gate), conversions C1 + C2:
// C1 — the sponsor-room funding flow (public-work enable -> settlement
// fund) gains a hard room cap + no-overage default at funding time (P5/R4).
// C2 — a credit-exposure line on the claim/board surface: award + bond at
// risk + pool fee, one line, knowable pre-claim (R2/R3). Display only.
// Real store, real escrow journal; prices are the First Shift bands.
function fixture(t) {
  const dir = mkdtempSync(join(tmpdir(), 'public-sponsor-cap-')), file = join(dir, 'room.sqlite');
  const clock = Date.now();
  const store = new RoomStore(file, { now: () => clock });
  store.initialize(initialRoom());
  const producer = store.identities.create('Producer');
  const state = structuredClone(store.room('commons').state);
  state.members.worker = { id: 'worker', revision: 1, kind: 'agent', active: true, displayName: 'Worker', permissions: ['read'] };
  store.db.prepare('UPDATE rooms SET projection=? WHERE id=?').run(JSON.stringify(state), 'commons');
  store.db.prepare('INSERT INTO identity_links VALUES (?,?,?,?)').run('commons', producer.identityId, 'worker', clock);
  store.bountyEscrow.ensureGenesis('commons');
  const makeTask = (offerId, amountMinor) => {
    const terms = { kind: 'task', title: `Task ${offerId}`, summary: 'Settle me', acceptanceCriteria: ['Correct result'],
      repositoryUrl: 'https://github.com/example/project',
      reward: amountMinor === null ? { kind: 'unpaid' } : { kind: 'work_trade', unit: 'credit', amountMinor },
      approvalPolicy: { mode: 'human' } };
    store.projectOffers.create('commons', 'owner', { requestId: `create-${offerId}`, offerId, reviewerMemberIds: ['owner'], terms });
    store.projectOffers.transition('commons', 'owner', offerId, 'publish', { requestId: `publish-${offerId}`, expectedRevision: 1 });
  };
  const enable = (offerId, extra = {}) => store.publicWorkClaims.enable('commons', 'owner', offerId,
    { requestId: `enable-${offerId}`, expectedRevision: 2, expectedTermsVersion: 1, repositoryRef: 'main', files: [`${offerId}.txt`], ...extra });
  t.after(() => { store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, producer, makeTask, enable };
}

const millis = (store, account) => ['payable', 'locked', 'attributed', 'approved'].map(state =>
  store.db.prepare("SELECT COALESCE(SUM(amount),0) AS t FROM bounty_journal WHERE room_id='commons' AND account_id=? AND lot_state=?").get(account, state).t);
const conserved = store => {
  const check = store.bountyEscrow.verifyConservation('commons');
  assert.equal(check.ok, true, `conservation violated: ${JSON.stringify(check.violations)}`);
};
const code = expected => error => error.code === expected;

test('cap input conversion: credits at the funding act, millis inside, malformed refused', () => {
  assert.equal(sponsorRoomCapMillisOf(undefined), null);
  assert.equal(sponsorRoomCapMillisOf(null), null);
  assert.equal(sponsorRoomCapMillisOf(100), 100_000);
  assert.equal(sponsorRoomCapMillisOf(2.5), 2_500);
  assert.equal(sponsorRoomCapMillisOf('100'), undefined);
  assert.equal(sponsorRoomCapMillisOf(0), undefined);
  assert.equal(sponsorRoomCapMillisOf(-5), undefined);
  assert.equal(sponsorRoomCapMillisOf(0.0001), undefined); // sub-milli precision is not a credit amount
  assert.equal(sponsorRoomCapMillisOf(Number.NaN), undefined);
});

test('C2 exposure: exact values for a 4-credit task (award 4, bond 1, fee 0.04)', () => {
  assert.deepEqual(publicWorkExposure(4000), {
    schema: 'public-work-exposure/1',
    awardMillis: 4000, awardCredits: 4,
    claimBondMillis: 1000, claimBondCredits: 1,
    poolFeeMillis: 40, poolFeeCredits: 0.04, poolFeeCarvedFromAward: true,
    sponsorDrawMillis: 4000, sponsorDrawCredits: 4,
    totalWorstCaseDrawMillis: 5000, totalWorstCaseDrawCredits: 5,
    line: 'Award 4 cr · claim bond at risk 1 cr · pool fee 0.04 cr (carved from the award on payout) · worst-case draw 5 cr',
  });
  // The fee follows the escrow's floor(1%) exactly, and unpaid/invalid
  // amounts have no exposure line at all.
  assert.equal(publicWorkExposure(2000).poolFeeCredits, 0.02);
  assert.equal(publicWorkExposure(2500).poolFeeMillis, 25);
  assert.equal(publicWorkExposure(null), null);
  assert.equal(publicWorkExposure(0), null);
  assert.equal(publicWorkExposure(undefined), null);
});

test('C1: funding within an explicit cap succeeds and the cap is visible on the settlement view', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  f.makeTask('task-b', '4000');
  const packet = f.enable('task-a', { sponsorRoomCap: 100 });
  assert.deepEqual(packet.settlement.roomCap, { capMillis: 100_000, capCredits: 100,
    outstandingMillis: 4000, outstandingCredits: 4, headroomMillis: 96_000, headroomCredits: 96 });
  // A later funding act without a cap draws against the stored cap.
  const second = f.enable('task-b');
  assert.equal(second.settlement.roomCap.outstandingCredits, 8);
  assert.equal(second.settlement.roomCap.headroomCredits, 92);
  assert.deepEqual(millis(store, 'owner'), [92_000, 8_000, 0, 0]);
  conserved(store);
});

test('C1: funding beyond the room cap is refused with sponsor_room_cap_exceeded and lists nothing', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  f.makeTask('task-b', '4000');
  f.enable('task-a', { sponsorRoomCap: 5 });
  assert.throws(() => f.enable('task-b'), code('sponsor_room_cap_exceeded'));
  // The refused funding is atomic, exactly like a balance failure: no
  // settlement link, no board listing, no money moved, cap untouched.
  assert.equal(store.publicWorkSettlement.link('task-b'), null);
  assert.deepEqual(store.publicWorkClaims.list().tasks.map(task => task.taskId), ['task-a']);
  assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
  assert.equal(store.publicWorkSettlement.roomCap('commons').capCredits, 5);
  conserved(store);
});

test('C1: a cap below the funding act itself refuses that act (no silent partial cap)', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  assert.throws(() => f.enable('task-a', { sponsorRoomCap: 3 }), code('sponsor_room_cap_exceeded'));
  assert.equal(store.publicWorkSettlement.link('task-a'), null);
  assert.equal(store.publicWorkSettlement.roomCap('commons'), null);
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  conserved(store);
});

test('C1 no-overage default: with no cap ever supplied, the cap defaults to the first funding amount', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  f.makeTask('task-b', '2000');
  const packet = f.enable('task-a');
  // The sponsor never set a cap: the room cap IS this funding act, so the
  // sponsor can never be drawn beyond what they explicitly funded.
  assert.equal(packet.settlement.roomCap.capCredits, 4);
  assert.equal(packet.settlement.roomCap.headroomCredits, 0);
  assert.throws(() => f.enable('task-b'), code('sponsor_room_cap_exceeded'));
  assert.equal(store.publicWorkSettlement.link('task-b'), null);
  assert.deepEqual(millis(store, 'owner'), [96_000, 4_000, 0, 0]);
  conserved(store);
});

test('C1: a later funding act may raise the cap, and the new cap binds from that act onward', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  f.makeTask('task-b', '4000');
  f.makeTask('task-c', '4000');
  f.enable('task-a', { sponsorRoomCap: 5 });
  assert.throws(() => f.enable('task-b'), code('sponsor_room_cap_exceeded'));
  const raised = f.enable('task-b', { sponsorRoomCap: 9 });
  assert.equal(raised.settlement.roomCap.capCredits, 9);
  assert.equal(raised.settlement.roomCap.outstandingCredits, 8);
  // The raised cap is a hard cap too: one more 4-credit task exceeds it.
  assert.throws(() => f.enable('task-c'), code('sponsor_room_cap_exceeded'));
  assert.deepEqual(millis(store, 'owner'), [92_000, 8_000, 0, 0]);
  conserved(store);
});

test('C1: settled-and-refunded awards stop counting as outstanding, freeing cap headroom', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  f.makeTask('task-b', '4000');
  f.enable('task-a', { sponsorRoomCap: 5 });
  assert.throws(() => f.enable('task-b'), code('sponsor_room_cap_exceeded'));
  // Run task-a to a terminal refund: claim, finish, reviewer rejects.
  store.publicWorkClaims.act('task-a', f.producer.secret, 'claim', { requestId: 'claim-a', expectedTermsVersion: 1 });
  const receipt = store.publicWorkClaims.act('task-a', f.producer.secret, 'finish',
    { requestId: 'finish-a', expectedTermsVersion: 1, generation: 1, artifactText: 'the result', checksReported: ['checked'] }).receipt;
  store.publicWorkReviews.decide('commons', 'owner', receipt.receiptId,
    { requestId: 'reject-a', expectedReviewRevision: 0, taskId: receipt.taskId, expectedTermsVersion: receipt.termsVersion,
      generation: receipt.generation, artifactSha256: receipt.artifact.sha256, reason: 'Not accepted', decision: 'rejected' });
  assert.equal(store.publicWorkSettlement.viewForOffer('task-a').phase, 'refunded');
  assert.equal(store.publicWorkSettlement.roomCap('commons').outstandingCredits, 0);
  // The same funding that was refused while task-a was outstanding now fits.
  const packet = f.enable('task-b');
  assert.equal(packet.settlement.roomCap.outstandingCredits, 4);
  conserved(store);
});

test('C1: a malformed sponsorRoomCap at enable is a 422, never silently ignored', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('task-a', '4000');
  for (const bad of ['100', 0, -5, 0.0001]) {
    assert.throws(() => f.enable('task-a', { sponsorRoomCap: bad }), code('invalid_public_work'), `cap ${bad}`);
  }
  assert.equal(store.publicWorkSettlement.link('task-a'), null);
  assert.deepEqual(millis(store, 'owner'), [100_000, 0, 0, 0]);
  conserved(store);
});

test('C2: the board packet carries the exposure line for paid tasks and nothing extra for unpaid ones', t => {
  const f = fixture(t), { store } = f;
  f.makeTask('paid-task', '4000');
  f.makeTask('free-task', null);
  const paid = f.enable('paid-task', { sponsorRoomCap: 100 });
  assert.deepEqual(paid.exposure, publicWorkExposure(4000));
  const free = f.enable('free-task');
  assert.equal('exposure' in free, false);
  // The same line is on the read + list surfaces an agent sees pre-claim.
  assert.deepEqual(store.publicWorkClaims.read('paid-task').exposure, publicWorkExposure(4000));
  const listed = store.publicWorkClaims.list().tasks;
  assert.deepEqual(listed.find(task => task.taskId === 'paid-task').exposure, publicWorkExposure(4000));
  assert.equal('exposure' in listed.find(task => task.taskId === 'free-task'), false);
  conserved(store);
});

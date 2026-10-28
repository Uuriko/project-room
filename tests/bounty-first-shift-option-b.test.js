// First Shift funding Option B — proof by test.
//
// Claim (design: project-room-first-shift.md §5 Option B + Appendix):
// a sponsor room's members receive the existing genesis endowment
// (GENESIS_CREDITS = 100 per member, server/bounty-escrow.mjs), and ONE
// sponsor lane's 100-credit endowment can fund the entire wave-1 operating
// float — 72 credits of task inventory (22 tasks at S/M/L = 2/4/8) plus
// 28 credits of repost/ratchet headroom — with ZERO new issuance.
//
// These tests use the membership-backed store pattern of
// tests/bounty-identity.test.js (production behaviour: genesis recipients
// are the room's live members via store.roomAuthority) and the escrow
// flow patterns of tests/bounty-escrow.test.js (post -> fund -> claim ->
// submit -> accept -> challenge window -> finalize -> closeEpoch).
// No test-only mint and no direct balance writes: the only provisioning
// call is the normal ensureGenesis path, and every credit movement goes
// through the escrow's own post/fund/claim/submit/accept machinery.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, GENESIS_CREDITS } from "../server/bounty-escrow.mjs";

const ROOM = "room-first-shift-sponsor";
const SPONSOR = "id:agent/first-shift-sponsor"; // the Option B sponsor lane
const WORKER = "id:agent/first-shift-worker";   // a distinct member lane

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const DAY_MS = 24 * 3_600_000;

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT first_shift_test");
    try { const out = fn(); db.exec("RELEASE first_shift_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO first_shift_test"); db.exec("RELEASE first_shift_test"); throw error; }
  };
  const members = {
    [SPONSOR]: { active: true, kind: "agent", displayName: "first-shift-sponsor" },
    [WORKER]: { active: true, kind: "agent", displayName: "first-shift-worker" },
  };
  const store = {
    db,
    transaction,
    readTransaction: transaction,
    roomAuthority: roomId => {
      assert.equal(roomId, ROOM);
      return { sequence: 1, ownerId: SPONSOR, members };
    },
  };
  // Deliberately NOT provisioned here: each test calls the normal
  // ensureGenesis path itself, so genesis is part of what is proved.
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  return { escrow, db };
}

const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const toMillis = credits => Math.round(credits * 1000);

// The conservation invariant from the escrow header, checked exactly (in
// milli-credits): payable + locked + attributed + approved = total_issued,
// and total_issued is exactly the expected (unchanged) genesis mint.
const expectConserved = (escrow, expectedTotalIssued) => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
  assert.equal(c.totalIssued, expectedTotalIssued,
    `total_issued moved: expected ${expectedTotalIssued}, got ${c.totalIssued}`);
  const bucketMillis = Object.values(c.byState).reduce((sum, v) => sum + toMillis(v), 0);
  assert.equal(bucketMillis, toMillis(c.totalIssued),
    `payable + locked + attributed + approved (${JSON.stringify(c.byState)}) != total_issued ${c.totalIssued}`);
  return c;
};

// Zero-new-issuance evidence at the journal level: the genesis rows are the
// room's only mint, so their count and sum must never change after the
// initial provisioning, however much funding/settlement happens afterwards.
const genesisTally = db => {
  const row = db.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS millis FROM bounty_journal WHERE room_id=? AND kind='genesis'")
    .get(ROOM);
  return { n: Number(row.n), millis: Number(row.millis) };
};

// Wave-1 inventory shape (design §3 + Appendix): 10 x S (2 cr) +
// 11 x M (4 cr) + 1 x L (8 cr) = 22 tasks, 72 credits.
const WAVE_AMOUNTS = Object.freeze([
  ...Array(10).fill(2),
  ...Array(11).fill(4),
  8,
]);

function postAndFund(escrow, { title, amount }) {
  const { bounty } = escrow.postBounty(ROOM,
    { poster: SPONSOR, title, criteria: "C", amount, deadline: isoFuture(10 * DAY_MS) });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: SPONSOR });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

// Fund the full wave-1 inventory from the sponsor lane alone, asserting
// conservation and an unchanged total_issued after EVERY funding step.
// Returns the funded bounties in posting order.
function fundWaveOne(escrow, expectedTotalIssued) {
  assert.equal(WAVE_AMOUNTS.length, 22);
  assert.equal(WAVE_AMOUNTS.reduce((a, b) => a + b, 0), 72);
  const funded = [];
  WAVE_AMOUNTS.forEach((amount, i) => {
    funded.push(postAndFund(escrow, { title: `First Shift wave-1 task ${i + 1}`, amount }));
    expectConserved(escrow, expectedTotalIssued);
  });
  return funded;
}

test("Option B genesis: a fresh sponsor room member is provisioned exactly the 100-credit genesis endowment via ensureGenesis", () => {
  const { escrow, db } = makeEscrow();
  assert.equal(GENESIS_CREDITS, 100);
  // Fresh room: nothing issued yet.
  assert.equal(bal(escrow, SPONSOR).total, 0);
  expectConserved(escrow, 0);

  const issued = escrow.ensureGenesis(ROOM);
  assert.equal(issued.issued, true);
  assert.deepEqual([...issued.lanes].sort(), [SPONSOR, WORKER].sort());

  // The sponsor member holds exactly the genesis endowment, all payable.
  const sponsor = bal(escrow, SPONSOR);
  assert.equal(sponsor.payable, GENESIS_CREDITS);
  assert.equal(sponsor.payable, 100);
  assert.equal(sponsor.locked, 0);
  assert.equal(sponsor.attributed, 0);
  assert.equal(sponsor.approved, 0);
  assert.equal(sponsor.total, 100);
  // Room total_issued is exactly the two members' endowments.
  expectConserved(escrow, 200);
  assert.deepEqual(genesisTally(db), { n: 2, millis: 200_000 });

  // ensureGenesis is idempotent per member: a second call mints nothing.
  const again = escrow.ensureGenesis(ROOM);
  assert.equal(again.issued, false);
  assert.deepEqual(again.lanes, []);
  assert.equal(bal(escrow, SPONSOR).payable, 100);
  expectConserved(escrow, 200);
  assert.deepEqual(genesisTally(db), { n: 2, millis: 200_000 });
});

test("Option B funding: one sponsor endowment funds the full wave-1 inventory (72 cr) plus a 5 cr ratchet repost, with zero new issuance", () => {
  const { escrow, db } = makeEscrow();
  escrow.ensureGenesis(ROOM);
  const totalIssuedBefore = escrow.verifyConservation(ROOM).totalIssued;
  assert.equal(totalIssuedBefore, 200);
  const genesisBefore = genesisTally(db);

  // The whole wave-1 inventory, funded from the sponsor's single balance.
  const funded = fundWaveOne(escrow, totalIssuedBefore);
  assert.equal(funded.length, 22);
  assert.ok(funded.every(b => b.state === "funded"));
  assert.equal(escrow.listBounties(ROOM, { group: "funded" }).length, 22);
  assert.equal(escrow.metrics(ROOM).lockedInEscrowCredits, 72);

  // Exactly the design arithmetic: 72 cr locked, 28 cr payable headroom left
  // in the SAME single endowment that started at 100 cr.
  const afterWave = bal(escrow, SPONSOR);
  assert.equal(afterWave.locked, 72);
  assert.equal(afterWave.payable, 28);
  assert.equal(afterWave.total, 100);
  // The worker lane's endowment was never touched: the sponsor lane alone
  // carried the wave.
  assert.equal(bal(escrow, WORKER).payable, 100);
  assert.equal(bal(escrow, WORKER).locked, 0);
  expectConserved(escrow, totalIssuedBefore);

  // The +25% ratchet case (design §1.4): a reposted M goes 4 -> 5 cr, and it
  // is fundable from the 28 cr headroom.
  const ratchet = postAndFund(escrow, { title: "First Shift reposted M (ratchet +25%)", amount: 5 });
  assert.equal(ratchet.state, "funded");
  assert.equal(ratchet.amount, 5);
  const afterRatchet = bal(escrow, SPONSOR);
  assert.equal(afterRatchet.locked, 77);
  assert.equal(afterRatchet.payable, 23);
  assert.equal(afterRatchet.total, 100);
  expectConserved(escrow, totalIssuedBefore);

  // Zero new issuance across all 23 funding operations: total_issued and the
  // genesis journal rows are identical to before any funding happened.
  assert.equal(escrow.verifyConservation(ROOM).totalIssued, totalIssuedBefore);
  assert.deepEqual(genesisTally(db), genesisBefore);
});

test("Option B settlement: accepting and settling one funded wave-1 task pays the award minus the 1% pool fee, with zero new issuance", () => {
  const { escrow, db } = makeEscrow();
  escrow.ensureGenesis(ROOM);
  const totalIssuedBefore = escrow.verifyConservation(ROOM).totalIssued;
  const genesisBefore = genesisTally(db);
  const funded = fundWaveOne(escrow, totalIssuedBefore);
  postAndFund(escrow, { title: "First Shift reposted M (ratchet +25%)", amount: 5 });
  assert.equal(bal(escrow, SPONSOR).locked, 77);
  assert.equal(bal(escrow, SPONSOR).payable, 23);

  // Settle one funded M task (4 cr) end to end through the existing escrow
  // machinery: claim (1 cr bond) -> submit -> accept -> challenge window ->
  // finalize -> epoch sweep (payout).
  const target = funded.find(b => b.amount === 4);
  escrow.claimBounty(ROOM, target.bountyId, { claimant: WORKER });
  assert.equal(bal(escrow, WORKER).payable, 99); // claim bond locked
  assert.equal(bal(escrow, WORKER).locked, 1);
  expectConserved(escrow, totalIssuedBefore);

  escrow.submitWork(ROOM, target.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, target.bountyId, { acceptor: SPONSOR,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm",
      citations: [{ criterionId: "c1", verdict: "pass" }] } });
  // Acceptance attributes the award to the worker; it does not pay yet, and
  // the sponsor's remaining funded inventory stays locked.
  assert.equal(bal(escrow, WORKER).attributed, 4);
  assert.equal(bal(escrow, SPONSOR).locked, 73);
  assert.equal(bal(escrow, SPONSOR).payable, 23);
  expectConserved(escrow, totalIssuedBefore);

  tick(3 * DAY_MS + 1); // 3-day challenge window for a >1 cr bounty
  const fin = escrow.finalizeBounty(ROOM, target.bountyId, { caller: WORKER });
  assert.equal(fin.action, "approved");
  const epoch = escrow.closeEpoch(ROOM, { caller: SPONSOR });
  assert.deepEqual(epoch.summary.swept, [target.bountyId]);
  assert.equal(escrow.getBounty(ROOM, target.bountyId).state, "paid");

  // Exactly the award minus the existing 1% pool fee reaches the worker:
  // 99 payable (after the bond lock) + 1 bond returned + 3.96 payout = 103.96,
  // and the pool holds exactly the 0.04 fee.
  assert.equal(bal(escrow, WORKER).payable, 103.96);
  assert.equal(bal(escrow, WORKER).locked, 0);
  assert.equal(bal(escrow, WORKER).attributed, 0);
  assert.equal(bal(escrow, WORKER).approved, 0);
  assert.equal(bal(escrow, "pool").payable, 0.04);
  // The sponsor is not refunded a settled award: the rest of the wave's
  // escrow (73 cr) stays locked and the headroom is unchanged.
  assert.equal(bal(escrow, SPONSOR).payable, 23);
  assert.equal(bal(escrow, SPONSOR).locked, 73);

  // Settlement issued nothing: total_issued and the genesis mint are exactly
  // what they were before any funding or settlement happened.
  expectConserved(escrow, totalIssuedBefore);
  assert.deepEqual(genesisTally(db), genesisBefore);
});

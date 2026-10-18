// Tests for the scheduled conservation audit (#4125): the payable-flow
// reconciliation inside BountyEscrow.verifyConservation and its caller,
// the escrow-conservation job (server/escrow-conservation.mjs).
//
// Before #4125 the audit reconciled only the escrow buckets and nothing
// ran it: a forged payout pair appended at both accounts' chain tails —
// valid hashes, valid chain — moved real balances while the audit
// returned { ok: true } (HUNT-CHAOS repro T3b). These tests pin:
//   - every honest settlement shape reconciles (no false positives);
//   - the T3b forged pair, a restore/replay double-append, a flipped
//     amount, and a forged bond disposition are all violations;
//   - the job path (not just the function) reports the failure with the
//     room named on the operator channel and a stable failure code.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";
import { runEscrowConservationAudit, escrowActivityPresent } from "../server/escrow-conservation.mjs";
import { jobByName, jobEnabled } from "../server/jobs.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";         // poster lane
const GROK = "id:agent/grokbot";      // worker lane
const INSTINCT = "id:agent/instinct";  // verifier lane
const CODEX = "id:agent/codex";        // challenger lane
const DAY_MS = 24 * 3600 * 1000;

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();
const isoNow = () => new Date(nowMs).toISOString();

function makeWorld(room = ROOM) {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(room);
  return { store, db, escrow, room };
}

function runToAccepted(world, { amount = 10 } = {}) {
  const { escrow, room } = world;
  const bounty = escrow.postBounty(room,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(30 * DAY_MS), verifierId: INSTINCT }).bounty;
  escrow.fundBounty(room, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(room, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(room, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(room, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: isoNow(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(room, bounty.bountyId);
}

// Accepted -> (challenge window passes) -> approved -> swept to paid.
function settlePaid(world, bounty) {
  tick(4 * DAY_MS);
  world.escrow.closeEpoch(world.room, {});
  world.escrow.closeEpoch(world.room, {});
  const settled = world.escrow.getBounty(world.room, bounty.bountyId);
  assert.equal(settled.state, "paid");
  return settled;
}

const conserved = world => world.escrow.verifyConservation(world.room);
const expectClean = world => {
  const c = conserved(world);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};

// Append a chain-valid forged movement pair at both accounts' tails —
// the T3b shape: hashes and chain verify, only the flows are wrong.
function forgePair(world, { bountyId, kind, fromAccount, fromState, toAccount, toState, amount }) {
  const { escrow, room } = world;
  const at = isoNow();
  escrow._append({ roomId: room, accountId: fromAccount, at, kind, bountyId,
    lotId: "lot_forged", amount: -amount, lotState: fromState, memo: "forged", actor: { kind: "rule", id: "test" } });
  escrow._append({ roomId: room, accountId: toAccount, at, kind, bountyId,
    lotId: "lot_forged", amount, lotState: toState, memo: "forged", actor: { kind: "rule", id: "test" } });
}

test("honest settlement shapes reconcile: full pay, split, dispute release + compensate, reject, timeout", () => {
  // Full pay through the epoch sweep.
  const w1 = makeWorld("room-full-pay");
  settlePaid(w1, runToAccepted(w1));
  expectClean(w1);

  // Dispute split, then the worker half sweeps.
  const w2 = makeWorld("room-split");
  const split = runToAccepted(w2, { amount: 10 });
  w2.escrow.disputeBounty(w2.room, split.bountyId, { challenger: CODEX, bond: 2.5, grounds: "partial credit" });
  w2.escrow.decideDispute(w2.room, split.bountyId, { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  w2.escrow.closeEpoch(w2.room, {});
  assert.equal(w2.escrow.getBounty(w2.room, split.bountyId).state, "paid");
  expectClean(w2);

  // Dispute rejected (release): award vests, challenger bond compensates
  // the worker, then the sweep pays.
  const w3 = makeWorld("room-release");
  const rel = runToAccepted(w3, { amount: 8 });
  w3.escrow.disputeBounty(w3.room, rel.bountyId, { challenger: CODEX, bond: 2, grounds: "unfair" });
  w3.escrow.decideDispute(w3.room, rel.bountyId, { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  w3.escrow.closeEpoch(w3.room, {});
  assert.equal(w3.escrow.getBounty(w3.room, rel.bountyId).state, "paid");
  expectClean(w3);

  // Dispute upheld (cancel): full refund, dispute bond returned, claim
  // bond forfeited to the pool.
  const w4 = makeWorld("room-cancel");
  const can = runToAccepted(w4, { amount: 6 });
  w4.escrow.disputeBounty(w4.room, can.bountyId, { challenger: CODEX, bond: 1.5, grounds: "bad work" });
  w4.escrow.decideDispute(w4.room, can.bountyId, { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(w4.escrow.getBounty(w4.room, can.bountyId).state, "refunded");
  expectClean(w4);

  // Rejected verification (free-miss failed): refund + claim bond forfeit.
  const w5 = makeWorld("room-reject");
  const rej = (() => {
    const b = w5.escrow.postBounty(w5.room,
      { poster: JILL, title: "T", criteria: "C", amount: 5, deadline: isoFuture(30 * DAY_MS) }).bounty;
    w5.escrow.fundBounty(w5.room, b.bountyId, { funder: JILL });
    w5.escrow.claimBounty(w5.room, b.bountyId, { claimant: GROK });
    w5.escrow.submitWork(w5.room, b.bountyId, { claimant: GROK,
      evidence: { evidenceUrl: "https://example.com/pr/2", summary: "junk" } });
    return w5.escrow.getBounty(w5.room, b.bountyId);
  })();
  w5.escrow.rejectWork(w5.room, rej.bountyId, { rejector: JILL, reason: "does not meet the criteria" });
  assert.equal(w5.escrow.getBounty(w5.room, rej.bountyId).state, "refunded");
  expectClean(w5);

  // Claimed, never submitted, deadline passes: timeout refund + forfeit.
  const w6 = makeWorld("room-timeout");
  const to = w6.escrow.postBounty(w6.room,
    { poster: JILL, title: "T", criteria: "C", amount: 4, deadline: isoFuture(DAY_MS) }).bounty;
  w6.escrow.fundBounty(w6.room, to.bountyId, { funder: JILL });
  w6.escrow.claimBounty(w6.room, to.bountyId, { claimant: GROK });
  tick(2 * DAY_MS);
  w6.escrow.closeEpoch(w6.room, {});
  assert.equal(w6.escrow.getBounty(w6.room, to.bountyId).state, "refunded");
  expectClean(w6);
});

test("verdict legs at `approved` reconcile: timeout-default forfeits the challenger bond before the sweep", () => {
  const world = makeWorld("room-approved-verdict");
  const bounty = runToAccepted(world, { amount: 10 });
  world.escrow.disputeBounty(world.room, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "nitpick" });
  tick(15 * DAY_MS); // past the 14-day dispute timeout: keeper defaults to release
  const { action } = world.escrow.finalizeBounty(world.room, bounty.bountyId, {});
  assert.equal(action, "released");
  const mid = world.escrow.getBounty(world.room, bounty.bountyId);
  assert.equal(mid.state, "approved", "verdict ran; the sweep has not");
  // The bond-forfeit credit to the pool already exists at this state —
  // it is a verdict leg, not unsettled flow.
  expectClean(world);
  world.escrow.closeEpoch(world.room, {});
  assert.equal(world.escrow.getBounty(world.room, bounty.bountyId).state, "paid");
  expectClean(world);
});

test("T3b: a forged payout pair on a paid bounty is a violation, and the job path reports it", () => {
  const world = makeWorld("room-t3b");
  const bounty = settlePaid(world, runToAccepted(world));
  expectClean(world);
  // Debit the poster's payable 2 credits, credit the worker's payable 2,
  // kind payout, the paid bounty's id — chain-valid, hash-valid.
  forgePair(world, { bountyId: bounty.bountyId, kind: "payout",
    fromAccount: JILL, fromState: "payable", toAccount: GROK, toState: "payable", amount: 2000 });
  assert.equal(world.escrow.balances(world.room, GROK).payable, 111.9, "sanity: the forged pair moved the worker's derived balance 109.9 -> 111.9");
  const c = conserved(world);
  assert.equal(c.ok, false, "forged pair must fail the audit");
  assert.ok(c.violations.some(v => v.includes("payable flow payout")), JSON.stringify(c.violations));
  // The job path reports it: errors count the room, the code is stable.
  const summary = runEscrowConservationAudit(world.store, { escrow: world.escrow });
  assert.equal(summary.rooms, 1);
  assert.equal(summary.errors, 1);
  assert.ok(summary.violations >= 1);
  assert.equal(summary.failureDetail.code, "conservation_violation");
});

test("a restore/replay double-append of the real payout pair is a violation", () => {
  const world = makeWorld("room-double");
  const bounty = settlePaid(world, runToAccepted(world));
  expectClean(world);
  // Re-append the genuine sweep legs (earner 9900, fee 100 for a 10cr award).
  forgePair(world, { bountyId: bounty.bountyId, kind: "payout",
    fromAccount: GROK, fromState: "approved", toAccount: GROK, toState: "payable", amount: 9900 });
  const c = conserved(world);
  assert.equal(c.ok, false);
  assert.ok(c.violations.some(v => v.includes("payable flow payout")), JSON.stringify(c.violations));
});

test("a flipped journal amount is caught by the job path", () => {
  const world = makeWorld("room-flip");
  settlePaid(world, runToAccepted(world));
  expectClean(world);
  world.db.prepare(`UPDATE bounty_journal SET amount = amount + 5000
    WHERE room_id = ? AND kind = 'payout' AND amount > 0`).run(world.room);
  const summary = runEscrowConservationAudit(world.store, { escrow: world.escrow });
  assert.equal(summary.errors, 1, JSON.stringify(summary));
  assert.equal(summary.failureDetail.code, "conservation_violation");
});

test("a forged bond-compensate pair (bond the challenger never locked) is a violation", () => {
  const world = makeWorld("room-bond-forge");
  const bounty = settlePaid(world, runToAccepted(world));
  expectClean(world);
  forgePair(world, { bountyId: bounty.bountyId, kind: "bond-compensate",
    fromAccount: CODEX, fromState: "locked", toAccount: GROK, toState: "payable", amount: 2500 });
  const c = conserved(world);
  assert.equal(c.ok, false);
  assert.ok(c.violations.some(v => v.includes("bond")), JSON.stringify(c.violations));
});

test("a payable flow on a live (nonterminal) bounty is a violation", () => {
  const world = makeWorld("room-live-flow");
  const bounty = runToAccepted(world);
  forgePair(world, { bountyId: bounty.bountyId, kind: "payout",
    fromAccount: JILL, fromState: "payable", toAccount: GROK, toState: "payable", amount: 500 });
  const c = conserved(world);
  assert.equal(c.ok, false);
  assert.ok(c.violations.some(v => v.includes("unsettled payable flow")), JSON.stringify(c.violations));
});

test("audit pass: clean rooms report zeroes; the job is disabled until escrow activity exists", () => {
  const empty = makeWorld("room-empty");
  empty.db.exec("DELETE FROM bounty_journal");
  assert.equal(escrowActivityPresent(empty.store), false);
  const job = jobByName("escrow-conservation");
  assert.ok(job, "escrow-conservation job is registered");
  assert.equal(jobEnabled(job, {}, empty.store), false);
  const world = makeWorld("room-clean");
  settlePaid(world, runToAccepted(world));
  assert.equal(escrowActivityPresent(world.store), true);
  assert.equal(jobEnabled(job, {}, world.store), true);
  const summary = runEscrowConservationAudit(world.store, { escrow: world.escrow });
  assert.deepEqual(summary, { rooms: 1, violations: 0, errors: 0 });
});

test("audit pass respects the deadline cooperatively and reports progress", () => {
  const world = makeWorld("room-budget");
  settlePaid(world, runToAccepted(world));
  const summary = runEscrowConservationAudit(world.store, { escrow: world.escrow, deadline: Date.now() - 1 });
  // The first room is always audited (progress before the check), so a
  // starved deadline still yields a complete single-room pass here.
  assert.equal(summary.rooms, 1);
  assert.equal(summary.errors, 0);
});

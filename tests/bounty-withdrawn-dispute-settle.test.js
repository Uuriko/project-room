// L01-C4 regression: a withdrawn / outcome-less dispute must NOT settle as
// a full RELEASE. Pre-fix, the keeper's terminal-retry branch treated
// `withdrawn` exactly like `resolved`, passed outcome:null into
// _settleDispute, and that null fell into the release branch: the award
// vested with the worker, the challenger's bond compensated the worker,
// the settlement was stamped verified-complete, and no bounty.decided
// event was emitted (the emission guard requires a non-empty outcome).
// A settlement with no decision is not a release: the keeper must refuse
// it and move no money at all.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-withdrawn-dispute";
const POSTER = "id:agent/jill";
const WORKER = "id:agent/grokbot";
const DECIDER = "id:agent/instinct";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return escrow;
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};
const expectConserved = escrow =>
  assert.equal(escrow.verifyConservation(ROOM).ok, true);

function runToAccepted(escrow) {
  const bounty = escrow.postBounty(ROOM,
    { poster: POSTER, title: "T", criteria: "C", amount: 4, deadline: isoFuture(3_600_000), verifierId: DECIDER }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: POSTER });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: WORKER });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: WORKER,
    evidence: { evidenceUrl: "https://example.invalid/work", summary: "work" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: POSTER,
    verifierAttestation: { at: new Date(nowMs).toISOString(), citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

function snapshotBalances(escrow) {
  return {
    poster: escrow.balances(ROOM, POSTER),
    worker: escrow.balances(ROOM, WORKER),
    pool: escrow.balances(ROOM, "pool"),
  };
}

// Drive a bounty to disputed, then replace its dispute record with the
// legacy terminal shape the keeper branch exists for (exactly the C-13
// probe shape): state withdrawn, no resolution, no forfeited bond, while
// the bounty itself is still disputed and unsettled.
function runToWithdrawnDispute(escrow) {
  const bounty = runToAccepted(escrow);
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: POSTER, bond: 1, grounds: "criterion c1 is not met" });
  const original = escrow._disputeRecords.get(dispute.disputeId);
  escrow._disputeRecords.set(dispute.disputeId, Object.freeze({
    ...original, state: "withdrawn", resolution: null, forfeitedBond: 0,
  }));
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("withdrawn dispute: keeper finalize refuses, moves no money, stamps nothing", () => {
  const escrow = makeEscrow();
  const bounty = runToWithdrawnDispute(escrow);
  expectConserved(escrow);
  // Exact balances at the disputed point (C-13 probe figures for this shape):
  // poster locked the 1cr dispute bond; worker holds the 4cr award attributed.
  const before = snapshotBalances(escrow);
  assert.equal(before.poster.payable, 95);
  assert.equal(before.poster.locked, 1);
  assert.equal(before.worker.payable, 99);
  assert.equal(before.worker.attributed, 4);
  assert.equal(before.pool.payable, 0);
  const eventsBefore = escrow.listEvents(ROOM).length;

  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state");

  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "disputed");
  assert.equal(after.resolution, null);
  assert.deepEqual(snapshotBalances(escrow), before);
  const newEvents = escrow.listEvents(ROOM).slice(eventsBefore);
  assert.equal(newEvents.filter(e => e.type === "bounty.decided").length, 0);
  assert.equal(newEvents.filter(e => e.type === "bounty.released").length, 0);
  assert.equal(newEvents.filter(e => e.type === "bounty.settled").length, 0);
  expectConserved(escrow);
});

test("withdrawn dispute: the 14-day timeout default must not settle it either", () => {
  const escrow = makeEscrow();
  const bounty = runToWithdrawnDispute(escrow);
  const before = snapshotBalances(escrow);
  expectConserved(escrow);
  tick(15 * 24 * 3_600_000); // past DISPUTE_TIMEOUT_MS
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state");
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "disputed");
  assert.equal(after.resolution, null);
  assert.deepEqual(snapshotBalances(escrow), before);
  assert.equal(escrow.listEvents(ROOM).filter(e => e.type === "bounty.decided").length, 0);
  expectConserved(escrow);
});

test("outcome-less resolved dispute: keeper finalize refuses as well", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId,
    { challenger: POSTER, bond: 1, grounds: "criterion c1 is not met" });
  const original = escrow._disputeRecords.get(dispute.disputeId);
  escrow._disputeRecords.set(dispute.disputeId, Object.freeze({
    ...original, state: "resolved", resolution: null, forfeitedBond: 0,
  }));
  const before = snapshotBalances(escrow);
  expectConserved(escrow);
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).resolution, null);
  assert.deepEqual(snapshotBalances(escrow), before);
  expectConserved(escrow);
});

test("control: a decided (rejected) dispute still settles as a release with bond compensation", () => {
  const escrow = makeEscrow();
  const bounty = runToAccepted(escrow);
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: POSTER, bond: 1, grounds: "criterion c1 is not met" });
  const { resolution } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: DECIDER, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(resolution.kind, "release");
  assert.equal(resolution.settlement.kind, "verified-complete");
  assert.equal(escrow.balances(ROOM, WORKER).payable, 100); // +1 bond compensation
  assert.ok(escrow.listEvents(ROOM).some(e => e.type === "bounty.decided"));
  expectConserved(escrow);
});

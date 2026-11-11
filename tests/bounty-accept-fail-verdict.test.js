// Regression tests for register row 5 (F-S2a-2): acceptance must not pay
// against a stored `fail` attestation verdict.
//
// Defect (V6 CONFIRMED; A-SPINE §5 re-executed): acceptWork validated the
// attestation's shape via citationsAgainstRubric (verdicts pass|fail, every
// pinned criterion cited) but never required the verdicts to be `pass`, so
// an all-fail attestation attributed and paid exactly like a pass
// (worker 99 -> 103.96 on a 4-credit bounty).
//
// Cure: acceptWork refuses with `verdict_not_pass` when any cited verdict
// is not `pass`. The work stays `submitted`; the fail path remains
// rejectWork (worker settles at zero). The pass path is unchanged.
//
// Same in-memory store double as tests/bounty-approval-modes.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";       // poster
const GROK = "id:agent/grokbot";    // worker
const INSTINCT = "id:agent/instinct"; // verifier

let nowMs = 1_786_000_000_000;

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return error; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const evidence = { evidenceUrl: "https://example.com/pr/1", summary: "flawed paragraph" };
const attest = verdict => ({ citations: [{ criterionId: "c1", verdict }] });

function runToSubmitted(escrow, overrides = {}) {
  const bounty = escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 4,
    deadline: new Date(nowMs + 3_600_000).toISOString(), verifierId: INSTINCT, ...overrides }).bounty;
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("fail attestation: accept is refused (verdict_not_pass), nothing attributes, work stays submitted", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  const err = expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest("fail") }), "verdict_not_pass");
  assert.match(err.message, /c1/);
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted");
  assert.equal(after.attestation, null);
  // No money moved: poster still holds the 4 locked; worker has only the claim bond locked.
  assert.equal(escrow.balances(ROOM, JILL).locked, 4);
  assert.equal(escrow.balances(ROOM, GROK).attributed, 0);
  assert.equal(escrow.balances(ROOM, GROK).payable, 99);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("fail attestation: refused accept pays 0 through finalize + closeEpoch", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest("fail") }), "verdict_not_pass");
  nowMs += 3 * 24 * 3600 * 1000 + 1000;
  escrow.closeEpoch(ROOM, { caller: JILL });
  const worker = escrow.balances(ROOM, GROK);
  // Zero paid for the work: the worker never exceeds their 100 genesis
  // (the claim bond may release back — that is their own money, not pay).
  assert.ok(worker.payable <= 100, `worker payable ${worker.payable} exceeds genesis`);
  assert.equal(worker.attributed, 0);
  assert.equal(worker.reputation.completedBounties, 0);
  assert.equal(worker.reputation.earnedCredits, 0);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("mixed attestation (one pass, one fail): accept is refused", () => {
  const { escrow } = makeEscrow();
  const rubric = [{ criterionId: "c1", description: "one" }, { criterionId: "c2", description: "two" }];
  const bounty = runToSubmitted(escrow, { rubric });
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: { citations: [
      { criterionId: "c1", verdict: "pass" }, { criterionId: "c2", verdict: "fail" }] } }), "verdict_not_pass");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  assert.equal(escrow.balances(ROOM, GROK).attributed, 0);
});

test("after a refused fail-accept, rejectWork still settles the worker at zero", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  expectCode(() => escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest("fail") }), "verdict_not_pass");
  const rejected = escrow.rejectWork(ROOM, bounty.bountyId, { rejector: JILL, reason: "criterion c1 not met" });
  assert.equal(rejected.settlement.kind, "failed");
  assert.equal(rejected.settlement.workerCredits, 0);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

test("pass attestation: accept path unchanged — attributes in full and pays 3.96 net of the 0.04 fee", () => {
  const { escrow } = makeEscrow();
  const bounty = runToSubmitted(escrow);
  const accepted = escrow.acceptWork(ROOM, bounty.bountyId,
    { acceptor: JILL, verifierAttestation: attest("pass") });
  assert.equal(accepted.bounty.state, "accepted");
  assert.equal(accepted.attribution.amount, 4);
  assert.equal(escrow.balances(ROOM, GROK).attributed, 4);
  nowMs += 3 * 24 * 3600 * 1000 + 1000;
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(fin.action, "approved");
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.paid, [{ bountyId: bounty.bountyId, paid: 3.96, fee: 0.04 }]);
  const worker = escrow.balances(ROOM, GROK);
  assert.equal(worker.payable, 103.96);
  assert.equal(worker.reputation.completedBounties, 1);
  assert.equal(worker.reputation.earnedCredits, 3.96);
  assert.equal(escrow.verifyConservation(ROOM).ok, true);
});

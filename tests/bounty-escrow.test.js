// Unit tests for server/bounty-escrow.mjs (slice 1: escrowed bounties).
//
// A minimal in-memory store double: node:sqlite plus a SAVEPOINT-based
// transaction() that supports the nesting the escrow module relies on
// (RoomStore.transaction behaves the same in production).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, canonicalLane, toMillis, normalizeActor } from "../server/bounty-escrow.mjs";

const ROOM = "room-test";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane
const INSTINCT = "id:agent/instinct"; // verifier / challenger lane
const CODEX = "id:agent/codex";

let nowMs = 1_786_000_000_000;
const tick = ms => { nowMs += ms; };
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow(db = new DatabaseSync(":memory:")) {
  const transaction = fn => {
    db.exec("SAVEPOINT escrow_test");
    try { const out = fn(); db.exec("RELEASE escrow_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO escrow_test"); db.exec("RELEASE escrow_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs });
  escrow.ensureGenesis(ROOM);
  return { escrow, db };
}

const bal = (escrow, lane) => escrow.balances(ROOM, lane);
const expectConserved = escrow => {
  const c = escrow.verifyConservation(ROOM);
  assert.equal(c.ok, true, `conservation violated: ${JSON.stringify(c.violations)}`);
};
const expectCode = (fn, code) => {
  try { fn(); } catch (error) { assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`); return; }
  assert.fail(`expected EscrowError ${code}, no error thrown`);
};

const post = (escrow, overrides = {}) => escrow.postBounty(ROOM,
  { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000), ...overrides }).bounty;

// Post -> fund -> claim -> submit -> accept.
function runToAccepted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("genesis issues 100 credits per lane and conservation holds on empty room", () => {
  const { escrow } = makeEscrow();
  for (const lane of [JILL, GROK, INSTINCT, CODEX]) {
    const b = bal(escrow, lane);
    assert.equal(b.payable, 100);
    assert.equal(b.locked, 0);
    assert.equal(b.total, 100);
  }
  expectConserved(escrow);
  escrow.ensureGenesis(ROOM);
  assert.equal(bal(escrow, JILL).payable, 100);
});

test("canonicalLane maps room member ids to ledger lanes", () => {
  assert.equal(canonicalLane("id:agent/jill"), "id:agent/jill");
  assert.equal(canonicalLane("id:agent:jill"), "id:agent/jill");
  assert.equal(canonicalLane("pool"), "pool");
  assert.throws(() => canonicalLane(""), /identity/);
});

test("normalizeActor derives agent/human kinds and honors explicit actors", () => {
  assert.deepEqual(normalizeActor(null, "id:agent/jill"), { kind: "agent", id: "id:agent/jill" });
  assert.deepEqual(normalizeActor(null, "john"), { kind: "human", id: "john" });
  assert.deepEqual(normalizeActor({ kind: "rule", id: "x" }, "id:agent/jill"), { kind: "rule", id: "x" });
});

test("post creates PROPOSED: locks nothing, sequential id, poster auto-watches", () => {
  const { escrow } = makeEscrow();
  const before = bal(escrow, JILL);
  const { bounty, receipt } = escrow.postBounty(ROOM,
    { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) });
  assert.equal(bounty.state, "proposed");
  assert.equal(bounty.group, "proposed");
  assert.match(bounty.bountyId, /^ROOMTEST-1$/);
  assert.deepEqual(bounty.watchers, [JILL]);
  assert.equal(receipt.kind, "propose");
  assert.deepEqual(receipt.actor, { kind: "agent", id: JILL });
  // Nothing locked: submission != commitment.
  assert.deepEqual(bal(escrow, JILL), before);
  expectConserved(escrow);
  // Second bounty gets the next sequential id.
  const b2 = post(escrow, { title: "T2" });
  assert.match(b2.bountyId, /^ROOMTEST-2$/);
});

test("proposed bounties are not claimable and are excluded from metrics", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK }), "invalid_state");
  const m = escrow.metrics(ROOM);
  assert.deepEqual(m.byGroup, { funded: 0, claimed: 0, "in-review": 0, paid: 0, cancelled: 0 });
  assert.equal(m.openBounties, 0);
  assert.equal(m.lockedInEscrowCredits, 0);
  // ...but they are still listable (triage inbox).
  assert.equal(escrow.listBounties(ROOM, { group: "proposed" }).length, 1);
  expectConserved(escrow);
});

test("post rejects negative, zero, oversized and over-precise amounts", () => {
  const { escrow } = makeEscrow();
  const base = { poster: JILL, title: "T", criteria: "C", deadline: isoFuture(3_600_000) };
  for (const amount of [-1, 0, NaN, Infinity, 0.0001, 1.2345, 1_000_001])
    expectCode(() => escrow.postBounty(ROOM, { ...base, amount }), "invalid_amount");
  const b = post(escrow, { amount: 0.001 });
  assert.equal(b.amount, 0.001);
  assert.equal(toMillis(1_000_000), 1_000_000_000);
  assert.throws(() => toMillis(1_000_001), /exceeds the 1000000-credit cap/);
  expectConserved(escrow);
});

test("fund locks the budget: poster-only, single transition, needs funds", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 10 });
  // Non-poster cannot fund.
  expectCode(() => escrow.fundBounty(ROOM, bounty.bountyId, { funder: GROK }), "not_authorized");
  const { bounty: funded, receipt } = escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  assert.equal(funded.state, "funded");
  assert.equal(funded.group, "funded");
  assert.deepEqual(receipt.actor, { kind: "agent", id: JILL });
  assert.equal(receipt.event.before, "proposed");
  assert.equal(receipt.event.after, "funded");
  assert.equal(bal(escrow, JILL).payable, 90);
  assert.equal(bal(escrow, JILL).locked, 10);
  // Double fund is rejected.
  expectCode(() => escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL }), "invalid_state");
  // Funding more than the poster holds fails.
  const big = post(escrow, { amount: 95, title: "big" });
  expectCode(() => escrow.fundBounty(ROOM, big.bountyId, { funder: JILL }), "insufficient_funds");
  expectConserved(escrow);
});

test("decline cancels with a reason; duplicate cancels with Duplicate label", () => {
  const { escrow } = makeEscrow();
  const d = post(escrow, { title: "meh" });
  const declined = escrow.declineBounty(ROOM, d.bountyId, { decliner: JILL, reason: "out of scope" }).bounty;
  assert.equal(declined.state, "cancelled");
  assert.equal(declined.group, "cancelled");
  assert.equal(declined.declineReason, "out of scope");
  expectCode(() => escrow.declineBounty(ROOM, d.bountyId, { decliner: JILL, reason: "x" }), "invalid_state");
  const d2 = post(escrow, { title: "meh-2" });
  expectCode(() => escrow.declineBounty(ROOM, d2.bountyId, { decliner: JILL }), "invalid_input");

  const canon = post(escrow, { title: "canonical" });
  const dup = post(escrow, { title: "dup" });
  const duplicated = escrow.duplicateBounty(ROOM, dup.bountyId, { marker: JILL, canonicalId: canon.bountyId }).bounty;
  assert.equal(duplicated.state, "cancelled");
  assert.equal(duplicated.label, "Duplicate");
  assert.equal(duplicated.duplicateOf, canon.bountyId);
  expectCode(() => escrow.duplicateBounty(ROOM, dup.bountyId, { marker: JILL, canonicalId: canon.bountyId }), "invalid_state");
  expectCode(() => escrow.duplicateBounty(ROOM, canon.bountyId, { marker: JILL, canonicalId: "ROOMTEST-999" }), "unknown_bounty");
  expectCode(() => escrow.duplicateBounty(ROOM, canon.bountyId, { marker: JILL, canonicalId: canon.bountyId }), "invalid_input");
  // Cancelled bounties are not claimable and hold no budget.
  expectCode(() => escrow.claimBounty(ROOM, d.bountyId, { claimant: GROK }), "invalid_state");
  expectConserved(escrow);
  assert.equal(escrow.listBounties(ROOM, { group: "cancelled" }).length, 2);
});

test("snooze defers a proposal: stays open, keeps time-in-state", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  tick(60_000);
  const until = isoFuture(7 * 24 * 3_600_000);
  const { bounty: snoozed, receipt } = escrow.snoozeBounty(ROOM, bounty.bountyId, { snoozer: JILL, until });
  assert.equal(snoozed.state, "proposed");
  assert.equal(snoozed.group, "proposed");
  assert.equal(snoozed.snoozedUntil, new Date(until).toISOString());
  assert.equal(receipt.event.type, "bounty.snoozed");
  // Snooze does not reset time-in-state (no state change).
  assert.ok(snoozed.timeInStateMs >= 60_000, `timeInStateMs=${snoozed.timeInStateMs}`);
  expectCode(() => escrow.snoozeBounty(ROOM, bounty.bountyId, { snoozer: JILL, until: isoFuture(-1) }), "invalid_input");
  // A snoozed proposal is protected from expired-unfunded while deferred.
  tick(3_600_000 + 1);
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state");
  expectConserved(escrow);
});

test("proposed bounties past deadline expire unfunded via the keeper", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  tick(3_600_000 + 1);
  const { bounty: expired, action } = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  assert.equal(action, "expired-unfunded");
  assert.equal(expired.state, "cancelled");
  assert.equal(expired.group, "cancelled");
  assert.equal(expired.declineReason, "expired unfunded");
  expectConserved(escrow);
});

test("claim locks the 1-credit bond; double claim is rejected; only funded is claimable", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  const { receipt } = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  assert.equal(receipt.kind, "bond-lock");
  assert.deepEqual(receipt.actor, { kind: "agent", id: GROK });
  const claimed = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(claimed.state, "claimed");
  assert.equal(claimed.group, "claimed");
  assert.equal(bal(escrow, GROK).locked, 1);
  assert.equal(bal(escrow, GROK).payable, 99);
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: INSTINCT }), "already_claimed");
  expectConserved(escrow);
});

test("watch is sticky: claim expiry does not unfollow", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.watchBounty(ROOM, bounty.bountyId, { watcher: INSTINCT });
  assert.deepEqual(escrow.getBounty(ROOM, bounty.bountyId).watchers, [JILL, INSTINCT]);
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(3_600_000 + 1); // claim window passes with no submission
  escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: JILL });
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "refunded");
  // Unclaim (expiry) did not unfollow the watcher.
  assert.deepEqual(after.watchers, [JILL, INSTINCT]);
  expectConserved(escrow);
});

test("submit stores the evidence receipt; only the claimant may submit", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  const evidence = { evidenceUrl: "https://example.com/pr/7", evidenceKind: "pr", summary: "shipped",
    checksClaimed: ["tests pass"], producerId: "grokbot" };
  const { bounty: submitted, receipt } = escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK, evidence });
  assert.equal(submitted.state, "submitted");
  assert.equal(submitted.group, "in-review");
  assert.equal(receipt.kind, "submit");
  assert.equal(receipt.evidence.evidenceUrl, evidence.evidenceUrl);
  assert.deepEqual(receipt.actor, { kind: "agent", id: GROK });
  expectCode(() => escrow.submitWork(ROOM, bounty.bountyId, { claimant: INSTINCT, evidence }), "invalid_state");
  expectConserved(escrow);
});

test("accept is a gated approval event: attribution is its explicit consequence", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "done" } });
  const { bounty: accepted, approval, attribution, receipt } =
    escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  assert.equal(accepted.state, "accepted");
  assert.equal(accepted.group, "in-review");
  // The approval is explicit and attributed.
  assert.equal(approval.decision, "approved");
  assert.deepEqual(approval.by, { kind: "agent", id: JILL });
  assert.equal(receipt.event.type, "bounty.accepted");
  assert.equal(receipt.event.before, "submitted");
  assert.equal(receipt.event.after, "accepted");
  assert.deepEqual(receipt.event.actor, { kind: "agent", id: JILL });
  assert.equal(receipt.event.data.approval.decision, "approved");
  // ...and only the approval converts the lot.
  assert.equal(attribution.claimant, GROK);
  assert.equal(bal(escrow, GROK).attributed, 10);
  assert.equal(bal(escrow, JILL).locked, 0);
  // Distinct-member review policy: the claimant cannot accept their own work.
  const b2 = post(escrow, { title: "T2" });
  escrow.fundBounty(ROOM, b2.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, b2.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, b2.bountyId, { claimant: GROK, evidence: { evidenceUrl: "https://example.com/pr/2", summary: "x" } });
  expectCode(() => escrow.acceptWork(ROOM, b2.bountyId, { acceptor: GROK, verifierAttestation: { note: "self", citations: [{ criterionId: "c1", verdict: "pass" }] } }), "not_authorized");
  expectConserved(escrow);
});

test("time-in-state is computed on reads and resets on transition", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  tick(5_000);
  let read = escrow.getBounty(ROOM, bounty.bountyId);
  assert.ok(read.timeInStateMs >= 5_000, `timeInStateMs=${read.timeInStateMs}`);
  assert.equal(typeof read.stateChangedAt, "string");
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  read = escrow.getBounty(ROOM, bounty.bountyId);
  assert.ok(read.timeInStateMs < 5_000, `timeInStateMs=${read.timeInStateMs}`);
  const listed = escrow.listBounties(ROOM, { group: "funded" });
  assert.equal(listed.length, 1);
  assert.ok(typeof listed[0].timeInStateMs === "number");
});

test("challenge window auto-approves, then the epoch sweep pays 99% + 1% pool fee and returns the bond", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 0.5 });
  assert.equal(bounty.group, "in-review");
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state");
  tick(24 * 3_600_000 + 1); // micro-bounty window: 24h
  const fin = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: GROK });
  assert.equal(fin.action, "approved");
  assert.equal(fin.receipt.actor.kind, "rule"); // mechanical transition
  const epoch = escrow.closeEpoch(ROOM, { caller: JILL });
  assert.deepEqual(epoch.summary.swept, [bounty.bountyId]);
  assert.equal(bal(escrow, GROK).payable, 100.495); // 99 + 0.495 award + 1.0 bond returned
  assert.equal(bal(escrow, "pool").payable, 0.005);
  assert.equal(bal(escrow, GROK).locked, 0); // bond returned
  const paid = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(paid.state, "paid");
  assert.equal(paid.group, "paid");
  const m = escrow.metrics(ROOM);
  assert.equal(m.byGroup.paid, 1);
  assert.equal(m.paidOutCredits, 0.495);
  assert.equal(m.poolFeesCredits, 0.005);
  expectConserved(escrow);
});

test("dispute bond must be exactly 25% of the bounty", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10 });
  for (const bond of [2.4, 2.6, 5])
    expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond, grounds: "bad" }), "invalid_bond");
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "bad work" });
  assert.equal(dispute.bond, 2.5);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).group, "in-review");
  expectConserved(escrow);
});

test("dispute RELEASE path: rejected challenge vests the award, bond compensates the worker", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks wrong" });
  assert.equal(dispute.decider, INSTINCT); // designated verifier seats tier-1
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId, { decider: CODEX, outcome: "rejected", reasonCodes: [] }), "not_authorized");
  const before = bal(escrow, GROK).payable;
  const { bounty: settled, receipt } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] });
  assert.equal(settled.resolution.kind, "release");
  assert.deepEqual(receipt.actor, { kind: "agent", id: INSTINCT }); // settlement attributed to the decider
  escrow.closeEpoch(ROOM, {});
  // Worker got the 2.5 bond as delay compensation (no fee) + 99% of the award + bond returned.
  assert.equal(bal(escrow, GROK).payable, before + 2.5 + 9.9 + 1);
  assert.equal(bal(escrow, "pool").payable, 0.1);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).group, "paid");
  expectConserved(escrow);
});

test("dispute CANCEL path: upheld challenge refunds the poster in full, no fee", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "plagiarized" });
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "cancel");
  assert.equal(settled.group, "cancelled");
  assert.equal(bal(escrow, JILL).payable, 100); // full refund, no fee
  assert.equal(bal(escrow, CODEX).payable, 100); // challenger bond returned
  assert.equal(bal(escrow, "pool").payable, 1); // claimant's flaked bond slashed to the pool
  expectConserved(escrow);
});

test("timeout refunds the award in full with no fee and forfeits the claim bond (anti-flake ladder rung 1)", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 8 });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  tick(3_600_000 + 1);
  const { action, receipt } = escrow.finalizeBounty(ROOM, bounty.bountyId, { caller: INSTINCT });
  assert.equal(action, "refunded");
  assert.equal(receipt.actor.kind, "rule");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.state, "refunded");
  assert.equal(settled.group, "cancelled");
  assert.equal(bal(escrow, JILL).payable, 100); // full refund, no fee
  assert.equal(bal(escrow, GROK).payable, 99); // rung 1: claim bond forfeited to the pool, not returned
  assert.equal(bal(escrow, "pool").payable, 1); // forfeited bond lands in the pool
  const flake = escrow.balances(ROOM, GROK).flake;
  assert.equal(flake.strikes, 1);
  assert.equal(flake.rung, 1);
  assert.equal(flake.bondMultiplier, 1);
  expectConserved(escrow);
});

test("the claimant cannot dispute their own submission; double disputes rejected", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow);
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: GROK, bond: 2.5, grounds: "self" }), "not_authorized");
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "bad" });
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "also bad" }), "dispute_exists");
  expectConserved(escrow);
});

test("no designated verifier means no authorized decider: dispute is honestly unavailable", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 4 }); // no verifierId
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 1, grounds: "meh" });
  const d = escrow.getDispute(ROOM, dispute.disputeId);
  assert.equal(d.decider, null); // slice 1 seats no improvised decider
  assert.ok(d.unavailable, "expected an honest-unavailable reason");
  // Nobody may rule without a seated decider.
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: JILL, outcome: "rejected", reasonCodes: ["frivolous"] }), "not_authorized");
  expectConserved(escrow);
});

test("unresolved disputes default to RELEASE after 14 days via permissionless finalize", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 4, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 1, grounds: "meh" });
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "adjudicating");
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).decider, INSTINCT);
  tick(15 * 24 * 3_600_000);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, {}); // anyone may finalize
  assert.equal(action, "released");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.resolution.kind, "release");
  assert.equal(settled.resolution.outcome, "timeout-default");
  expectConserved(escrow);
});

test("idempotency keys replay the original response without re-executing", () => {
  const { escrow } = makeEscrow();
  const first = escrow.idemExecute(ROOM, "k-1", "bounty.post", 201, () =>
    escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }));
  assert.equal(first.replayed, false);
  const replay = escrow.idemExecute(ROOM, "k-1", "bounty.post", 201, () => { throw new Error("must not re-execute"); });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.bounty.bountyId, first.body.bounty.bountyId);
  assert.equal(escrow.listBounties(ROOM).length, 1); // posted exactly once
  expectConserved(escrow);
});

test("reputation counts only paid completions", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10 });
  // Claims, submissions and acceptances alone earn no reputation.
  assert.equal(bal(escrow, GROK).reputation.completedBounties, 0);
  tick(3 * 24 * 3_600_000 + 1);
  escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  escrow.closeEpoch(ROOM, {});
  const rep = bal(escrow, GROK).reputation;
  assert.equal(rep.completedBounties, 1);
  assert.equal(rep.earnedCredits, 9.9);
  assert.equal(rep.earnedCredits30d, 9.9);
  expectConserved(escrow);
});

test("transfers move payable credits; history receipts are actor-attributed with before/after", () => {
  const { escrow } = makeEscrow();
  const { receipt } = escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 5 });
  assert.deepEqual(receipt.actor, { kind: "agent", id: JILL });
  assert.equal(bal(escrow, JILL).payable, 95);
  assert.equal(bal(escrow, GROK).payable, 105);
  const hist = escrow.history(ROOM, JILL);
  const tx = hist.find(r => r.kind === "transfer");
  assert.ok(tx);
  assert.deepEqual(tx.actor, { kind: "agent", id: JILL });
  assert.deepEqual(tx.before, { account: JILL, lotState: "payable" });
  assert.deepEqual(tx.after, { account: GROK, lotState: "payable" });
  assert.equal(tx.amount, 5);
  // State filter matches the movement's resulting lot state.
  assert.ok(escrow.history(ROOM, JILL, { state: "payable" }).length >= 1);
  assert.equal(escrow.history(ROOM, JILL, { state: "locked" }).length, 0);
  expectCode(() => escrow.transfer(ROOM, { from: JILL, to: JILL, amount: 1 }), "invalid_input");
  expectCode(() => escrow.transfer(ROOM, { from: JILL, to: GROK, amount: 1000 }), "insufficient_funds");
  expectConserved(escrow);
  for (const r of hist) {
    assert.equal(typeof r.receiptId, "string");
    assert.equal(typeof r.at, "string");
    assert.ok(Array.isArray(r.entries) && r.entries.length >= 1);
  }
});

test("bracketed and bare bounty references are inert: no side effects, no text scanning", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  // The module exposes no text-reference scanner: bracketed ids are link-only.
  assert.equal(typeof escrow.applyTextReference, "undefined");
  assert.equal(typeof escrow.resolveBracketedReference, "undefined");
  // Lookups are exact-match: bracketed or decorated forms do not resolve.
  expectCode(() => escrow.getBounty(ROOM, `[${bounty.bountyId}]`), "unknown_bounty");
  expectCode(() => escrow.claimBounty(ROOM, `[${bounty.bountyId}]`, { claimant: GROK }), "unknown_bounty");
  // A bounty whose title mentions another bounty id causes no side effects.
  const other = post(escrow, { title: `see [${bounty.bountyId}] for context` });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "proposed");
  assert.equal(escrow.getBounty(ROOM, other.bountyId).state, "proposed");
  expectConserved(escrow);
});

test("sequential ids are per-room and gapless within a room", () => {
  const { escrow } = makeEscrow();
  const a = post(escrow, { title: "a" });
  const b = post(escrow, { title: "b" });
  assert.equal(a.bountyId, "ROOMTEST-1");
  assert.equal(b.bountyId, "ROOMTEST-2");
  // Another room has its own sequence.
  const other = escrow.postBounty("room-other", { poster: JILL, title: "x", criteria: "y", amount: 1, deadline: isoFuture(1000) }).bounty;
  assert.equal(other.bountyId, "ROOMOTHER-1");
});

test("metrics exclude proposed items from every count and total", () => {
  const { escrow } = makeEscrow();
  post(escrow, { title: "draft-1" });
  post(escrow, { title: "draft-2" });
  const funded = post(escrow, { title: "live", amount: 20 });
  escrow.fundBounty(ROOM, funded.bountyId, { funder: JILL });
  const m = escrow.metrics(ROOM);
  assert.equal(m.byGroup.funded, 1);
  assert.equal(m.byGroup.proposed ?? 0, 0);
  assert.ok(!("proposed" in m.byGroup), "proposed must not appear in metrics groups");
  assert.equal(m.openBounties, 1);
  assert.equal(m.lockedInEscrowCredits, 20);
  // A declined draft leaves no trace in the money totals.
  const d = post(escrow, { title: "draft-3" });
  escrow.declineBounty(ROOM, d.bountyId, { decliner: JILL, reason: "nope" });
  const m2 = escrow.metrics(ROOM);
  assert.equal(m2.byGroup.cancelled, 1);
  assert.equal(m2.lockedInEscrowCredits, 20);
  expectConserved(escrow);
});

test("persistence across restart: journal, bounties, watchers and sequences rehydrate", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = mkdtempSync(join(tmpdir(), "escrow-restart-"));
  const file = join(dir, "escrow.db");
  const mk = () => {
    const db = new DatabaseSync(file);
    const transaction = fn => {
      db.exec("SAVEPOINT t");
      try { const r = fn(); db.exec("RELEASE t"); return r; }
      catch (e) { db.exec("ROLLBACK TO t"); db.exec("RELEASE t"); throw e; }
    };
    return new BountyEscrow({ db, transaction, readTransaction: transaction }, { now: () => nowMs });
  };
  const e1 = mk();
  e1.ensureGenesis(ROOM);
  const bounty = e1.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 20, deadline: isoFuture(3_600_000) }).bounty;
  e1.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  e1.watchBounty(ROOM, bounty.bountyId, { watcher: CODEX });
  e1.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  const e2 = mk(); // "restart": fresh module instance, same file
  const rb = e2.getBounty(ROOM, bounty.bountyId);
  assert.equal(rb.state, "claimed");
  assert.equal(rb.bountyId, bounty.bountyId);
  assert.deepEqual(rb.watchers, [JILL, CODEX]);
  assert.equal(e2.balances(ROOM, GROK).locked, 1);
  // Sequence continues, not resets.
  const b2 = e2.postBounty(ROOM, { poster: JILL, title: "T2", criteria: "C", amount: 1, deadline: isoFuture(3_600_000) }).bounty;
  assert.equal(b2.bountyId, "ROOMTEST-2");
  const c = e2.verifyConservation(ROOM);
  assert.equal(c.ok, true, JSON.stringify(c.violations));
  e2.db.close(); e1.db.close();
  const { rmSync } = await import("node:fs");
  rmSync(dir, { recursive: true, force: true });
});

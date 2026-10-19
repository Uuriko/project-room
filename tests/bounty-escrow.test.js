// Unit tests for server/bounty-escrow.mjs (slice 1: escrowed bounties).
//
// A minimal in-memory store double: node:sqlite plus a SAVEPOINT-based
// transaction() that supports the nesting the escrow module relies on
// (RoomStore.transaction behaves the same in production).
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { BountyEscrow, DISPUTE_TIMEOUT_MS, bountyEscrowSchema, canonicalLane, convergeBountyDeployedSchema, toMillis, normalizeActor } from "../server/bounty-escrow.mjs";

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
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
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

test("poster cannot claim their own bounty (#3008); a different member still can", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow);
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  // Self-claim is rejected: every later guard (accept distinct from claimant,
  // claimant cannot dispute own submission) assumes poster != claimant, so a
  // self-claimed bounty dead-ends in-review with escrow + bond locked.
  expectCode(() => escrow.claimBounty(ROOM, bounty.bountyId, { claimant: JILL }), "not_authorized");
  // The rejected claim changes nothing: bounty stays funded/unclaimed, no
  // bond was locked for the poster, and conservation holds.
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "funded");
  assert.equal(after.claimant, null);
  assert.equal(bal(escrow, JILL).locked, 10); // only the funded amount
  expectConserved(escrow);
  // A different member can still claim it.
  const { receipt } = escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  assert.equal(receipt.kind, "bond-lock");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).claimant, GROK);
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
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  for (const bond of [2.4, 2.6, 5])
    expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond, grounds: "bad" }), "invalid_bond");
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad work" });
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
  const bounty = runToAccepted(escrow, { verifier: INSTINCT });
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: GROK, bond: 2.5, grounds: "self" }), "not_authorized");
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad" });
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "also bad" }), "dispute_exists");
  expectConserved(escrow);
});

test("no designated verifier: the dispute is refused before the bond locks (#3727)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 4 }); // no verifierId
  const challengerBefore = bal(escrow, INSTINCT);
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 1, grounds: "meh" }), "dispute_unavailable");
  // Nothing moved: no bond locked, the bounty was never frozen, no record.
  assert.deepEqual(bal(escrow, INSTINCT), challengerBefore);
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "accepted");
  assert.equal(after.disputeId, null);
  expectConserved(escrow);
});

test("a designated verifier who cannot sit (verifier is the claimant) also refuses the dispute (#3727)", () => {
  const { escrow } = makeEscrow();
  const bounty = post(escrow, { amount: 4, verifierId: GROK }); // verifier = future claimant
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  const challengerBefore = bal(escrow, INSTINCT);
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 1, grounds: "meh" }), "dispute_unavailable");
  assert.deepEqual(bal(escrow, INSTINCT), challengerBefore);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "accepted");
  expectConserved(escrow);
});

test("a disputeDecider-designated bounty opens and seats the designee (#3727)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAcceptedDesignated(escrow, { disputeDeciderId: CODEX }); // verifier stays null
  assert.equal(bounty.verifier, null);
  assert.equal(bounty.disputeDecider, CODEX);
  // The early seat-or-refuse check resolves the designation as
  // disputeDecider ?? verifier — a verifier-only read would refuse this
  // dispute as unavailable (the rail's shape: verifier null, decider
  // named). A neutral challenger disputes; the designee seats.
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "bad work" });
  assert.equal(dispute.decider, CODEX);
  assert.equal(dispute.unavailable, null);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(escrow);
});

test("legacy undecidable dispute: the 14-day timeout returns the bond to the challenger (#3727)", () => {
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 4 }); // no verifier
  // Replay the pre-fix disputeBounty mutations by hand — lock the
  // challenger's bond, walk the machine to evidence + markUnavailable,
  // and point the bounty row at the record. Post-fix disputeBounty
  // refuses this open; this is the legacy row shape the keeper guards.
  const disputeId = "dsp_legacy3727";
  const bondMillis = 1000; // exactly 25% of 4 credits
  escrow._move({ roomId: ROOM, at: new Date(nowMs).toISOString(),
    from: { account: CODEX, state: "payable" }, to: { account: CODEX, state: "locked" },
    amountMillis: bondMillis, kind: "bond-lock", bountyId: bounty.bountyId, lotId: "lot_legacy3727",
    memo: `dispute bond for ${disputeId}`, actor: null });
  const machine = escrow._disputes;
  let d = machine.open({ disputeId, bountyId: bounty.bountyId, bountyAmount: 4000, raisedBy: CODEX, reason: "meh", kind: "economic", bond: bondMillis });
  escrow._persistDispute(ROOM, d);
  d = machine.challenge(disputeId, { by: CODEX }); escrow._persistDispute(ROOM, d);
  d = machine.submitEvidence(disputeId, { by: CODEX, summary: "meh" }); escrow._persistDispute(ROOM, d);
  d = machine.markUnavailable(disputeId, "no-designated-verifier: panel-majority voting is not in slice 1");
  escrow._persistDispute(ROOM, d);
  db.prepare("UPDATE bounty_records SET state='disputed', dispute_id=?, dispute_opened_ms=? WHERE bounty_id=?")
    .run(disputeId, nowMs, bounty.bountyId);
  assert.equal(bal(escrow, CODEX).locked, 1); // bond locked into the undecidable record
  tick(14 * 24 * 3_600_000 + 1);
  const { action } = escrow.finalizeBounty(ROOM, bounty.bountyId, {});
  assert.equal(action, "released");
  const settled = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(settled.resolution.outcome, "timeout-default");
  // The award still releases, but the bond came home to the challenger —
  // never to the worker as compensation for a hearing that could not
  // happen, and not to the pool.
  assert.equal(bal(escrow, CODEX).payable, 100);
  assert.equal(bal(escrow, CODEX).locked, 0);
  assert.equal(bal(escrow, "pool").payable, 0);
  expectConserved(escrow);
});

// Post -> fund -> claim -> submit -> accept with arbitrary post overrides.
function runToAcceptedDesignated(escrow, overrides = {}) {
  const bounty = post(escrow, { amount: 10, ...overrides });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL, verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("the designated verifier cannot dispute into their own decider seat: refused before the bond locks (#3727 × #3866)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  const challengerBefore = bal(escrow, INSTINCT);
  // The designee IS the challenger (party-as-judge): seating reports the
  // `unavailable` signal #3866 introduced for exactly this case, and
  // #3727 refuses the dispute at open on that signal — the record never
  // exists, so there is no seat to abuse and no bond is ever locked.
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "judging my own case" }), "dispute_unavailable");
  assert.deepEqual(bal(escrow, INSTINCT), challengerBefore);
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "accepted");
  assert.equal(after.disputeId, null);
  // Nothing exists for anyone to rule on — least of all the challenger.
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] }), "invalid_state");
  expectConserved(escrow);
});

test("the designated dispute decider cannot dispute into their own seat either: refused before the bond locks (#3727 × #3866)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAcceptedDesignated(escrow, { disputeDeciderId: CODEX });
  const challengerBefore = bal(escrow, CODEX);
  // Same composition on the disputeDecider designation: the designee
  // raising the dispute makes the seat unavailable (#3866's signal),
  // and the dispute refuses at open (#3727) instead of opening
  // seat-less with the challenger's bond locked.
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "my own case" }), "dispute_unavailable");
  assert.deepEqual(bal(escrow, CODEX), challengerBefore);
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "accepted");
  assert.equal(after.disputeId, null);
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: CODEX, outcome: "upheld", reasonCodes: ["criterion-unmet"] }), "invalid_state");
  expectConserved(escrow);
});

test("a verifier's dispute still seats a distinct designated decider (precedence unchanged)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAcceptedDesignated(escrow, { verifierId: INSTINCT, disputeDeciderId: CODEX });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: INSTINCT, bond: 2.5, grounds: "not my seat" });
  assert.equal(dispute.decider, CODEX); // disputeDecider ?? verifier, as before
  assert.equal(dispute.unavailable, null);
  expectConserved(escrow);
});

test("decide-time guard: a pre-seated self-dispute cannot be ruled on by its raiser", () => {
  const db = new DatabaseSync(":memory:");
  const { escrow } = makeEscrow(db);
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "neutral challenge" });
  assert.equal(dispute.decider, INSTINCT);
  // Simulate a dispute record seated before the challenger exclusion
  // existed: the seated decider is also the dispute's raiser, persisted
  // exactly as such a legacy row would sit in bounty_disputes.
  const legacy = Object.freeze({ ...escrow.getDispute(ROOM, dispute.disputeId), raisedBy: INSTINCT });
  escrow._disputeRecords.set(dispute.disputeId, legacy);
  escrow._persistDispute(ROOM, legacy);
  // A fresh escrow over the same store rehydrates the legacy row.
  const { escrow: rehydrated } = makeEscrow(db);
  const row = rehydrated.getDispute(ROOM, dispute.disputeId);
  assert.equal(row.raisedBy, INSTINCT);
  assert.equal(row.decider, INSTINCT);
  expectCode(() => rehydrated.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "upheld", reasonCodes: ["criterion-unmet"] }), "not_authorized");
  // The refusal is a refusal, not a settlement: the bounty stays disputed.
  assert.equal(rehydrated.getBounty(ROOM, bounty.bountyId).state, "disputed");
  expectConserved(rehydrated);
});

test("getDispute is room-scoped: another room's dispute reads as absent (L-P2-10)", () => {
  const { escrow } = makeEscrow();
  const OTHER = "room-other";
  escrow.ensureGenesis(OTHER);
  const bounty = runToAccepted(escrow, { amount: 4, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 1, grounds: "meh" });
  assert.ok(escrow.getDispute(ROOM, dispute.disputeId), "own room reads it");
  assert.equal(escrow.getDispute(OTHER, dispute.disputeId), undefined,
    "cross-room read must not leak the dispute");
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
    escrow.postBounty(ROOM, { poster: JILL, title: "T", criteria: "C", amount: 10, deadline: isoFuture(3_600_000) }), { callerLane: JILL });
  assert.equal(first.replayed, false);
  const replay = escrow.idemExecute(ROOM, "k-1", "bounty.post", 201, () => { throw new Error("must not re-execute"); }, { callerLane: JILL });
  assert.equal(replay.replayed, true);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.bounty.bountyId, first.body.bounty.bountyId);
  assert.equal(escrow.listBounties(ROOM).length, 1); // posted exactly once
  expectConserved(escrow);
});

test("a deployed idempotency table converges and does not return another member's body", () => {
  const legacy = bountyEscrowSchema.replace("    scope_key TEXT,\n    caller_lane TEXT,\n    version INTEGER,\n    request_hash TEXT,\n", "").replace("PRIMARY KEY(room_id, scope_key)", "PRIMARY KEY(room_id, idem_key)").replace(/  CREATE INDEX IF NOT EXISTS bounty_idempotency_scope[^;]+;\n/, "");
  const db = new DatabaseSync(":memory:");
  db.exec(legacy);
  db.prepare("INSERT INTO bounty_idempotency (room_id, idem_key, route, status, response, created_at) VALUES (?,?,?,?,?,?)")
    .run(ROOM, "legacy-key", "bounty.post", 201, JSON.stringify({ secret: "legacy-body" }), "2026-09-26T00:00:00.000Z");
  convergeBountyDeployedSchema(db);
  const { escrow } = makeEscrow(db);
  assert.doesNotThrow(() => escrow.verifySchema());
  const first = escrow.idemExecute(ROOM, "shared-key", "bounty.post", 201, () => ({ secret: "jill-body" }), { callerLane: JILL });
  assert.equal(first.replayed, false);
  assert.equal(escrow.idemExecute(ROOM, "shared-key", "bounty.post", 201, () => ({ secret: "codex-body" }), { callerLane: CODEX }).body.secret, "codex-body");
  const replay = escrow.idemExecute(ROOM, "shared-key", "bounty.post", 201, () => { throw new Error("must not re-execute"); }, { callerLane: JILL });
  assert.equal(replay.replayed, true);
  assert.equal(replay.body.secret, "jill-body");
  expectCode(() => escrow.idemExecute(ROOM, "legacy-key", "bounty.post", 201, () => { throw new Error("must not re-execute"); }, { callerLane: JILL }), "idempotency_actor_mismatch");
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
    return new BountyEscrow({ db, transaction, readTransaction: transaction }, { now: () => nowMs, allowLegacyStringLanes: true });
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

// qa200-reg-13 regression sweep: the dispute SPLIT settlement path had no
// escrow-level test. It moves real money (halves the award, returns the
// challenger's bond), so these lock in the exact amounts, the no-double-move
// behavior, and conservation. Post-#3726 every dispute opens from accepted.

// Post -> fund -> claim -> submit (no accept).
function runToSubmitted(escrow, { amount = 10, verifier = null } = {}) {
  const bounty = post(escrow, { amount, verifierId: verifier });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  return escrow.getBounty(ROOM, bounty.bountyId);
}

test("dispute SPLIT from accepted: exact halves, challenger bond returned (never forfeited)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "partial credit" });
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "split");
  assert.equal(settled.resolution.bondForfeited, false, "split returns the bond; it never forfeits it");
  assert.equal(settled.state, "approved");
  // Nothing sits in a transient state: the full award moved out of the
  // attributed lot (worker half vested, poster half refunded).
  assert.equal(escrow.balances(ROOM, GROK).attributed, 0, "split leaves no attributed lot behind");
  // Half the award refunded to the poster in full (no fee), half vested with the worker.
  assert.equal(bal(escrow, JILL).payable, 95, "poster: 90 + 5 refund");
  assert.equal(bal(escrow, CODEX).payable, 100, "challenger bond returned in full");
  assert.equal(bal(escrow, CODEX).locked, 0);
  escrow.closeEpoch(ROOM, {});
  // Worker's half sweeps at 99% + 1% pool fee; the 1-credit claim bond returns.
  assert.equal(bal(escrow, GROK).payable, 99 + 4.95 + 1);
  assert.equal(bal(escrow, "pool").payable, 0.05);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).group, "paid");
  expectConserved(escrow);
});

test("#3726: a dispute cannot open on submitted work — no vesting without acceptance", () => {
  const { escrow } = makeEscrow();
  // The differential-escrow probe case: submitted work, disputed and ruled
  // "rejected", vested the award as approved (poster 87.5, worker 112.4)
  // through the settle-kind fall-through — bypassing acceptance,
  // attestation, and the challenge window. Option A makes it impossible:
  // the dispute cannot open, so no ruling on it can move money.
  const bounty = runToSubmitted(escrow, { amount: 10, verifier: INSTINCT });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "submitted");
  assert.throws(
    () => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad" }),
    error => error.code === "invalid_state" && /only on accepted work/.test(error.message));
  // The refusal happens before any bond movement: the challenger's bond is
  // never locked by a dispute that cannot open, and no dispute exists.
  assert.equal(bal(escrow, CODEX).payable, 100);
  assert.equal(bal(escrow, CODEX).locked, 0);
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted");
  assert.equal(after.disputeId, null);
  // With no dispute open, no ruling path exists for this bounty at all.
  expectCode(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "rejected", reasonCodes: ["evidence-insufficient"] }), "invalid_state");
  assert.equal(bal(escrow, JILL).payable, 90, "poster unchanged: award still locked");
  assert.equal(bal(escrow, GROK).payable, 99, "worker unchanged: claim bond still locked, nothing vested");
  expectConserved(escrow);
  // The submitted bounty's real remedies still work: acceptance unblocks a
  // dispute, and the dispute then behaves exactly as before.
  escrow.acceptWork(ROOM, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "bad" });
  assert.ok(dispute.disputeId);
  expectConserved(escrow);
});

test("#3726/F3: a refused dispute cannot vest by timeout — no dispute exists for the keeper to default after 14 days", () => {
  const { escrow } = makeEscrow();
  // Long deadline (30d) isolates the dispute-timeout vector from the
  // free-miss deadline settlement: only the 14-day dispute clock passes.
  const bounty = post(escrow, { amount: 10, verifierId: INSTINCT, deadline: isoFuture(30 * 24 * 3_600_000) });
  escrow.fundBounty(ROOM, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(ROOM, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(ROOM, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  // The dispute cannot open on submitted work (the Option A gateway).
  expectCode(() => escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "stall" }), "invalid_state");
  // 15 days pass — beyond DISPUTE_TIMEOUT_MS. At baseline an open dispute
  // defaulted to RELEASE here and vested the award with no ruling at all
  // (sweep findings-06 F3); with no dispute open there is nothing to default.
  tick(15 * 24 * 3_600_000);
  expectCode(() => escrow.finalizeBounty(ROOM, bounty.bountyId, {}), "invalid_state");
  escrow.closeEpoch(ROOM, {});
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "submitted");
  assert.equal(after.disputeId, null);
  assert.equal(after.resolution ?? null, null);
  // Nothing vested, nothing compensated, no bond ever moved.
  assert.equal(bal(escrow, GROK).payable, 99, "worker unchanged: claim bond still locked, award not vested");
  assert.equal(bal(escrow, GROK).approved, 0);
  assert.equal(bal(escrow, CODEX).payable, 100);
  assert.equal(bal(escrow, CODEX).locked, 0);
  assert.equal(bal(escrow, JILL).payable, 90, "poster unchanged: award still locked");
  expectConserved(escrow);
});

test("dispute SPLIT leaves no duplicate or dust: halves sum to the award exactly", () => {
  const { escrow } = makeEscrow();
  // Odd-millis award: floor/ceil split must still sum to the whole.
  const bounty = runToAccepted(escrow, { amount: 0.011, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 0.003, grounds: "partial" });
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "split");
  // 11 millis -> worker half 5, poster half 6; the poster's locked escrow is fully drained.
  assert.equal(bal(escrow, JILL).payable, 100 - 0.011 + 0.006);
  escrow.closeEpoch(ROOM, {});
  // Worker half sweeps with a floored 1% fee: floor(5/100) = 0 millis, so the
  // earner keeps the full 5 millis and the pool gets nothing.
  assert.equal(bal(escrow, GROK).payable, 99 + 1 + 0.005);
  assert.equal(bal(escrow, "pool").payable, 0);
  assert.equal(bal(escrow, CODEX).payable, 100);
  expectConserved(escrow);
});

test("dispute SPLIT of a 1-milli bounty: zero worker half vests nothing, whole milli refunds", () => {
  const { escrow } = makeEscrow();
  // Smallest postable award: 0.001 credits = 1 milli. floor(1/2) = 0, so the
  // worker's vesting half is zero millis — the settlement must not attempt a
  // zero-amount approve move (the journal rejects those), or the split throws
  // after the verdict is recorded and the bounty wedges in `disputed`.
  const bounty = runToAccepted(escrow, { amount: 0.001, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 0.001, grounds: "partial" });
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "split");
  assert.equal(settled.resolution.bondForfeited, false);
  assert.equal(settled.state, "approved");
  // The whole milli refunds to the poster; the worker vests zero.
  assert.equal(bal(escrow, JILL).payable, 100, "poster: 99.999 + 0.001 refund");
  assert.equal(bal(escrow, CODEX).payable, 100, "challenger bond returned in full");
  const lots = escrow.balances(ROOM, GROK);
  assert.equal(lots.attributed, 0, "split leaves no attributed lot behind");
  assert.equal(lots.approved, 0, "worker vested a zero half: nothing approved");
  assert.equal(bal(escrow, "pool").payable, 0);
  expectConserved(escrow);
});

// #3263 regression, from-accepted shape (the only shape since #3726): the
// split above lands the bounty in `approved` holding ZERO approved millis.
// The epoch sweep must not gate the claim-bond settlement (or the terminal
// transition) on a positive payout amount: closeEpoch completes the bounty
// to `paid` with worker 0 / fee 0 and returns the claimant's flat 1000ms
// claim bond, instead of recording "nothing approved to sweep" in
// summary.failed on every epoch forever.
test("dispute SPLIT of a 1-milli bounty: epoch sweep settles the claim bond and pays out zero (#3263)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 0.001, verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 0.001, grounds: "partial" });
  escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");
  assert.equal(bal(escrow, GROK).approved, 0);
  assert.equal(bal(escrow, GROK).locked, 1, "claim bond (1000ms = 1 credit) still locked before the sweep");
  const epoch = escrow.closeEpoch(ROOM, {});
  assert.equal(epoch.summary.failed, undefined, `epoch must not fail the zero-approved bounty: ${JSON.stringify(epoch.summary.failed)}`);
  assert.deepEqual(epoch.summary.swept, [bounty.bountyId]);
  assert.deepEqual(epoch.summary.paid, [{ bountyId: bounty.bountyId, paid: 0, fee: 0 }]);
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "paid");
  assert.equal(bal(escrow, GROK).locked, 0, "claim bond settled by the sweep");
  assert.equal(bal(escrow, GROK).payable, 100, "claim bond returned in full; zero payout adds nothing");
  assert.equal(bal(escrow, "pool").payable, 0, "no fee on a zero payout");
  // Terminal now: a second epoch neither retries nor fails the bounty.
  const epoch2 = escrow.closeEpoch(ROOM, {});
  assert.equal(epoch2.summary.failed, undefined);
  assert.deepEqual(epoch2.summary.swept, []);
  expectConserved(escrow);
});

// #3275: escrow settlement must be atomic across its two stores — the
// persisted store (SQLite, transactional) and the in-memory dispute machine
// (a caller-owned Map no transaction covers) — and closeEpoch must not
// commit a half-applied keeper action. Fault injection: _move is stubbed to
// throw mid-settlement, after earlier journal moves for the bounty landed.
const failNthMove = (escrow, bountyId, n) => {
  const original = escrow._move.bind(escrow);
  let seen = 0;
  escrow._move = args => {
    if (args.bountyId === bountyId && ++seen === n)
      throw new Error("injected mid-settlement failure");
    return original(args);
  };
  return () => { escrow._move = original; };
};

test("decideDispute settlement throw: machine and DB stay consistent, re-decision works (#3275)", () => {
  const { escrow } = makeEscrow();
  const bounty = runToAccepted(escrow, { amount: 10, verifier: INSTINCT });
  const { dispute } = escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "partial" });
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "adjudicating");
  // Split settlement moves from accepted (award already attributed):
  // approve worker half (1), refund poster half (2 — injected throw),
  // bond return (never reached).
  const restore = failNthMove(escrow, bounty.bountyId, 2);
  assert.throws(() => escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] }),
    /injected mid-settlement failure/);
  restore();
  // Both stores rolled back together: the DB bounty is still disputed with
  // no resolution, AND the in-memory machine is back to adjudicating (the
  // old code left it resolved/notified, ghost-blocking every retry with
  // 'cannot move resolved -> adjudicating').
  const after = escrow.getBounty(ROOM, bounty.bountyId);
  assert.equal(after.state, "disputed");
  assert.equal(after.resolution, null);
  const machine = escrow.getDispute(ROOM, dispute.disputeId);
  assert.equal(machine.state, "adjudicating");
  assert.ok(!machine.notified, "machine must not keep the finalized notification");
  assert.equal(machine.resolution, null);
  // No journal move from the aborted settlement survived.
  assert.equal(bal(escrow, JILL).payable, 90, "poster half refund must not commit");
  assert.equal(bal(escrow, GROK).attributed, 10, "the acceptance attribution stands; the split did not move it");
  assert.equal(bal(escrow, GROK).approved, 0);
  assert.equal(bal(escrow, CODEX).payable, 97.5, "challenger bond still locked, not returned");
  assert.equal(bal(escrow, CODEX).locked, 2.5);
  expectConserved(escrow);
  // The dispute is decidable again: the retry settles cleanly end-to-end.
  const { bounty: settled } = escrow.decideDispute(ROOM, bounty.bountyId,
    { decider: INSTINCT, outcome: "split", reasonCodes: ["criterion-unmet"] });
  assert.equal(settled.resolution.kind, "split");
  assert.equal(escrow.getDispute(ROOM, dispute.disputeId).state, "resolved");
  escrow.closeEpoch(ROOM, {});
  assert.equal(bal(escrow, JILL).payable, 95);
  assert.equal(bal(escrow, CODEX).payable, 100);
  assert.equal(bal(escrow, GROK).payable, 99 + 4.95 + 1);
  expectConserved(escrow);
});

test("closeEpoch keeper throw: per-bounty action applies nothing, epoch continues (#3275)", () => {
  const { escrow } = makeEscrow();
  const a = runToAccepted(escrow, { amount: 10 });
  tick(1); // distinct created_at so the epoch visits A before B
  const b = runToAccepted(escrow, { amount: 10 });
  tick(3 * 24 * 3_600_000 + 1); // challenge windows pass
  escrow.finalizeBounty(ROOM, a.bountyId, {});
  escrow.finalizeBounty(ROOM, b.bountyId, {});
  assert.equal(bal(escrow, GROK).payable, 98, "two claim bonds locked");
  assert.equal(bal(escrow, GROK).approved, 20);
  // Sweep moves for A: payout (1), fee (2 — injected throw), bond return
  // (never reached). The old code committed the payout inside the epoch
  // transaction and stranded A in `approved` with only the fee left.
  const restore = failNthMove(escrow, a.bountyId, 2);
  const epoch = escrow.closeEpoch(ROOM, {});
  restore();
  assert.equal(epoch.summary.failed?.length, 1);
  assert.equal(epoch.summary.failed[0].bountyId, a.bountyId);
  assert.deepEqual(epoch.summary.swept, [b.bountyId], "the epoch continues past the failed bounty");
  // A applied NOTHING: still approved with its full lot and claim bond.
  assert.equal(escrow.getBounty(ROOM, a.bountyId).state, "approved");
  assert.equal(escrow.getBounty(ROOM, b.bountyId).state, "paid");
  assert.equal(bal(escrow, GROK).approved, 10, "only A's lot remains approved");
  assert.equal(bal(escrow, GROK).locked, 1, "A's claim bond still locked");
  assert.equal(bal(escrow, GROK).payable, 98 + 9.9 + 1, "only B's payout + bond landed");
  expectConserved(escrow);
  // With the fault gone, the next epoch sweeps A completely.
  const epoch2 = escrow.closeEpoch(ROOM, {});
  assert.equal(epoch2.summary.failed, undefined);
  assert.deepEqual(epoch2.summary.swept, [a.bountyId]);
  assert.equal(escrow.getBounty(ROOM, a.bountyId).state, "paid");
  assert.equal(bal(escrow, GROK).payable, 98 + (9.9 + 1) * 2);
  assert.equal(bal(escrow, "pool").payable, 0.2);
  expectConserved(escrow);
});

// ---------------------------------------------------------------------------
// PIN-01 — KEEPER-TWINS (escrow twin): _keeperPass boundary pins
// (Fix Programme v2, clause (c)). The due-scan's SQL clauses have a JS twin
// in _keeperPass; the sweep found the twins can drift apart clause by clause
// invisibly. These pins drive closeEpoch (which snapshots and runs
// _keeperPass per bounty) at the exact boundary instants, with a
// one-millisecond-before control phase for each.

test("PIN-01 E-13: closeEpoch approves an accepted bounty AT its challenge end, not after", () => {
  nowMs = 1_786_000_000_000;
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow);
  const ends = db.prepare("SELECT challenge_ends_ms FROM bounty_records WHERE room_id=? AND bounty_id=?")
    .get(ROOM, bounty.bountyId).challenge_ends_ms;
  assert.ok(Number.isFinite(ends), "fixture carries a challenge end");
  nowMs = ends - 1;
  let epoch = escrow.closeEpoch(ROOM).summary;
  assert.deepEqual(epoch.approved, [], "not approved before the boundary");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "accepted");
  nowMs = ends; // `now >= challengeEndsMs` holds exactly here
  epoch = escrow.closeEpoch(ROOM).summary;
  assert.deepEqual(epoch.approved, [bounty.bountyId],
    "approved at the exact challenge end (E-13 flips >= to >)");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");
  expectConserved(escrow);
});

test("PIN-01 E-15: closeEpoch does NOT release a disputed bounty at exactly the dispute timeout", () => {
  nowMs = 1_786_000_000_000;
  const { escrow, db } = makeEscrow();
  const bounty = runToAccepted(escrow, { verifier: INSTINCT });
  escrow.disputeBounty(ROOM, bounty.bountyId, { challenger: CODEX, bond: 2.5, grounds: "looks wrong" });
  const opened = db.prepare("SELECT dispute_opened_ms FROM bounty_records WHERE room_id=? AND bounty_id=?")
    .get(ROOM, bounty.bountyId).dispute_opened_ms;
  assert.ok(Number.isFinite(opened), "fixture carries a dispute open time");
  nowMs = opened + DISPUTE_TIMEOUT_MS; // `now - opened > TIMEOUT` is false here
  let epoch = escrow.closeEpoch(ROOM).summary;
  assert.deepEqual(epoch.released, [], "no default release at the exact timeout (E-15 flips > to >=)");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "disputed");
  nowMs += 1; // one millisecond past: the timeout default fires
  epoch = escrow.closeEpoch(ROOM).summary;
  assert.equal(epoch.released.length, 1, "released one tick past the timeout");
  assert.equal(escrow.getBounty(ROOM, bounty.bountyId).state, "approved");
  expectConserved(escrow);
});

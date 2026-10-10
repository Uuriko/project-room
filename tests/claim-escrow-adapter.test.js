// BUILD LANE 11: claim -> escrow/evaluator-wedge adapter. Pure-module tests;
// no store, no I/O, no server imports.
//
// Authoring gate (.agents/skills/test-audit/SKILL.md): this is a new module,
// so no existing test owns these contracts. Each test below names (1) the
// contract it protects, (2) the credible regression that fails it.

import test from "node:test";
import assert from "node:assert/strict";
import {
  EscrowError,
  ESCROW_STATUSES,
  MIN_EVALUATORS,
  escrowInputOf,
  escrowStatusOf,
  offerEscrow,
  lockEscrowOnClaim,
  seatEvaluation,
  verdictGate,
  settleEscrowFromPull,
  refundEscrowOnExpiry,
} from "../server/claim-escrow-adapter.mjs";

const throwsCode = (fn, code) => assert.throws(fn, error => error instanceof EscrowError && error.code === code);
const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const legacy = { id: "w-legacy", state: "in_progress", owner: "quill" };
const fundedItem = (over = {}) => ({
  id: "w-escrow", state: "claimed", owner: "grok",
  escrow: Object.freeze({ status: "funded", budgetUnits: 1000, evaluatorCount: 3,
    evaluatorFeeBps: 100, platformFeeBps: 100, offeredAt: "2026-10-07T11:00:00.000Z",
    offeredBy: "quill", fundedAt: "2026-10-07T11:30:00.000Z", fundedBy: "grok",
    expiresInMs: 24 * 3600 * 1000, ...over }),
  ...over,
});

// 1. Contract: the adapter is opt-in only — legacy claims (no escrow field)
// can never observe it. Regression: a wiring bug routes a legacy claim into
// the adapter and its behavior changes (the backward-compat guarantee).
test("legacy claims report no escrow and the adapter never activates for them", () => {
  assert.equal(escrowStatusOf(legacy), "none");
  assert.equal(escrowStatusOf({ id: "x" }), "none");
  assert.equal(verdictGate(legacy, null), true);
  assert.equal(settleEscrowFromPull({ action: "pr_merged", item: { ...legacy, state: "done" } }, { now: NOW }), null);
  assert.equal(settleEscrowFromPull({ action: "pr_closed", item: { ...legacy, state: "unclaimed", owner: null } }, { now: NOW }), null);
  assert.equal(refundEscrowOnExpiry(legacy, { now: NOW }), null);
});

// 2. Contract: escrow input validation, including the anti-griefing floor
// (evaluatorCount >= 2 — lane-2 finding #1: buyer self-evaluation griefing).
// Regression: evaluatorCount 1 (or 0) accepted at offer time, recreating the
// ACP self-evaluation hole the wedge exists to close.
test("escrow input validation rejects griefable and malformed offers", () => {
  const valid = escrowInputOf({ budgetUnits: 1000, evaluatorCount: 3 });
  assert.deepEqual({ ...valid }, { budgetUnits: 1000, evaluatorCount: 3,
    evaluatorFeeBps: 100, platformFeeBps: 100, expiresInMs: null });
  assert.ok(Object.isFrozen(valid));
  assert.equal(escrowInputOf(null), null);
  assert.equal(escrowInputOf(undefined), null);
  throwsCode(() => escrowInputOf({ budgetUnits: 1000, evaluatorCount: 1 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: 1000, evaluatorCount: 0 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: 0, evaluatorCount: 2 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: -5, evaluatorCount: 2 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: 1.5, evaluatorCount: 2 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: Number.MAX_SAFE_INTEGER + 1, evaluatorCount: 2 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: 1000, evaluatorCount: 2, evaluatorFeeBps: 10001 }), "invalid_escrow_input");
  throwsCode(() => escrowInputOf({ budgetUnits: 1000 }), "invalid_escrow_input");
  assert.ok(ESCROW_STATUSES.includes("evaluating") && MIN_EVALUATORS === 2);
});

// 3. Contract: offering escrow on claim creation attaches the offer journal
// and the frozen escrow block. Regression: the create-path wiring drops the
// journal (settlement later has no record of the encumbered budget).
test("offerEscrow attaches an offer to an unclaimed claim", () => {
  const item = { id: "w-new", state: "unclaimed", owner: null };
  const { item: offered, journal } = offerEscrow(item, { budgetUnits: 2500, evaluatorCount: 2 },
    { actorId: "quill", now: NOW });
  assert.equal(offered.escrow.status, "offered");
  assert.equal(offered.escrow.budgetUnits, 2500);
  assert.equal(offered.escrow.offeredBy, "quill");
  assert.equal(offered.escrow.offeredAt, new Date(NOW).toISOString());
  assert.ok(Object.isFrozen(offered.escrow));
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "escrow_offered");
  assert.equal(journal[0].units, 2500);
  assert.equal(journal[0].claimId, "w-new");
  assert.ok(Object.isFrozen(journal[0]));
});

// 4. Contract: escrow can only be offered on unclaimed work, once.
// Regression: double-offer overwrites the first budget (funds accounting
// fork); offer on a claimed item lets a second funder attach mid-flight.
test("offerEscrow refuses non-unclaimed items and double offers", () => {
  throwsCode(() => offerEscrow({ id: "w", state: "claimed", owner: "grok" },
    { budgetUnits: 100, evaluatorCount: 2 }, { now: NOW }), "invalid_escrow_input");
  const once = offerEscrow({ id: "w", state: "unclaimed", owner: null },
    { budgetUnits: 100, evaluatorCount: 2 }, { now: NOW }).item;
  throwsCode(() => offerEscrow(once, { budgetUnits: 100, evaluatorCount: 2 }, { now: NOW }),
    "escrow_already_offered");
});

// 5. Contract: a create body with no escrow field leaves the claim
// untouched — the legacy create path is byte-identical. Regression: the
// adapter injects an empty escrow block into every new claim, changing what
// old readers and the receipts surface see.
test("offerEscrow with null input is a no-op returning the item unchanged", () => {
  const item = { id: "w-plain", state: "unclaimed", owner: null };
  const { item: out, journal } = offerEscrow(item, null, { now: NOW });
  assert.equal(out, item);
  assert.deepEqual(journal, []);
});

// 6. Contract: lease acquisition funds the escrow (ACP TRANSACTION) — the
// budget locks exactly when the worker takes the lease. Regression: funding
// at creation instead of claim (lane-2 failure #3: capital locked with no
// worker committed) or funding without a lease holder.
test("lockEscrowOnClaim funds the escrow when the worker takes the lease", () => {
  const offered = offerEscrow({ id: "w", state: "unclaimed", owner: null },
    { budgetUnits: 1000, evaluatorCount: 3 }, { actorId: "quill", now: NOW }).item;
  const claimed = { ...offered, state: "claimed", owner: "grok" };
  const { item: funded, journal } = lockEscrowOnClaim(claimed, "grok", { now: NOW });
  assert.equal(funded.escrow.status, "funded");
  assert.equal(funded.escrow.fundedBy, "grok");
  assert.equal(funded.escrow.fundedAt, new Date(NOW).toISOString());
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "escrow_funded");
  assert.equal(journal[0].units, 1000);
});

// 7. Contract: funding is single-shot and worker-bound (fail closed).
// Regression: double-fund (replay of the claim webhook funds twice) or a
// wiring bug funding a legacy claim silently.
test("lockEscrowOnClaim refuses misuse: wrong worker, wrong state, double-fund, legacy", () => {
  const offered = offerEscrow({ id: "w", state: "unclaimed", owner: null },
    { budgetUnits: 100, evaluatorCount: 2 }, { now: NOW }).item;
  const claimed = { ...offered, state: "claimed", owner: "grok" };
  throwsCode(() => lockEscrowOnClaim(claimed, "instinct", { now: NOW }), "escrow_not_owner");
  throwsCode(() => lockEscrowOnClaim({ ...offered, state: "in_progress", owner: "grok" }, "grok", { now: NOW }),
    "invalid_escrow_input");
  const funded = lockEscrowOnClaim(claimed, "grok", { now: NOW }).item;
  throwsCode(() => lockEscrowOnClaim(funded, "grok", { now: NOW }), "escrow_not_offered");
  throwsCode(() => lockEscrowOnClaim(legacy, "quill", { now: NOW }), "escrow_not_offered");
});

// 8. Contract: seating a verdict round moves funded escrow to evaluating and
// pins the round id (the tally that later closes the claim must be this
// round's). Regression: a stale/foreign round tally gates the done
// transition (verdictGate would accept another round's quorum).
test("seatEvaluation moves funded escrow to evaluating with the round pinned", () => {
  const { item: seated, journal } = seatEvaluation(fundedItem(), "round-7", { now: NOW });
  assert.equal(seated.escrow.status, "evaluating");
  assert.equal(seated.escrow.roundId, "round-7");
  assert.equal(journal[0].kind, "escrow_evaluating");
  const offered = offerEscrow({ id: "w", state: "unclaimed", owner: null },
    { budgetUnits: 100, evaluatorCount: 2 }, { now: NOW }).item;
  throwsCode(() => seatEvaluation(offered, "round-7", { now: NOW }), "escrow_not_active");
  throwsCode(() => seatEvaluation(fundedItem(), "", { now: NOW }), "invalid_escrow_input");
});

// 9. Contract: terminal escrow states must agree with the claim machine
// (released <=> done, refunded <=> unclaimed). Regression: a corrupt or
// half-applied settlement writes escrow "released" on a live claim and a
// later reader pays out twice.
test("escrowStatusOf enforces terminal-state agreement with the claim machine", () => {
  assert.equal(escrowStatusOf({ ...fundedItem(), state: "done",
    escrow: { ...fundedItem().escrow, status: "released" } }), "released");
  assert.equal(escrowStatusOf({ ...fundedItem(), state: "unclaimed", owner: null,
    escrow: { ...fundedItem().escrow, status: "refunded" } }), "refunded");
  assert.equal(escrowStatusOf(fundedItem()), "funded");
  throwsCode(() => escrowStatusOf({ ...fundedItem(), state: "in_progress",
    escrow: { ...fundedItem().escrow, status: "released" } }), "escrow_state_mismatch");
  throwsCode(() => escrowStatusOf({ ...fundedItem(), state: "done",
    escrow: { ...fundedItem().escrow, status: "refunded" } }), "escrow_state_mismatch");
  throwsCode(() => escrowStatusOf({ ...fundedItem(), escrow: { status: "bogus" } }), "invalid_escrow_input");
});

// 10. Contract: the done-transition gate. Legacy claims always pass;
// escrow claims need this round's quorum of approvals. Regression: the
// enforcing rollout (P1) lets a claim close on a below-quorum or foreign
// tally — the evaluator chair is empty again.
test("verdictGate requires this round's quorum for escrow claims, always passes legacy", () => {
  const seated = seatEvaluation(fundedItem(), "round-7", { now: NOW }).item;
  assert.equal(verdictGate(seated, { roundId: "round-7", approvals: 2, quorum: 2 }), true);
  assert.equal(verdictGate(seated, { roundId: "round-7", approvals: 1, quorum: 2 }), false);
  assert.equal(verdictGate(seated, { roundId: "round-8", approvals: 2, quorum: 2 }), false);
  assert.equal(verdictGate(seated, null), false);
  assert.equal(verdictGate(fundedItem(), { roundId: "round-7", approvals: 2, quorum: 2 }), false);
  assert.equal(verdictGate(legacy, null), true);
  assert.equal(verdictGate(legacy, { roundId: "x", approvals: 0, quorum: 2 }), true);
});

// 11. Contract: PR-merge settlement releases the exact split — provider
// remainder + evaluator fee + platform fee (the ACP split, lane-2 §COMPLETED).
// Regression: fee math drifts so the legs no longer sum to the budget.
test("settleEscrowFromPull releases the split on merge", () => {
  const item = { ...fundedItem(), state: "done", deliveryMode: "merged" };
  const { item: settled, journal } = settleEscrowFromPull(
    { action: "pr_merged", item, previousOwnerId: "grok", paths: [] }, { now: NOW });
  assert.equal(settled.escrow.status, "released");
  const split = settled.escrow.split;
  assert.deepEqual(split, { provider: 980, evaluator: 10, platform: 10 });
  assert.equal(split.provider + split.evaluator + split.platform, 1000);
  const kinds = journal.map(entry => entry.kind).sort();
  assert.deepEqual(kinds, ["escrow_released_evaluator", "escrow_released_platform", "escrow_released_provider"]);
  assert.ok(journal.every(entry => Object.isFrozen(entry)));
});

// 12. Contract: units conservation on odd budgets — integer math only, the
// remainder goes to the provider, never to fees. Regression: float division
// or banker rounding leaks a unit per settlement (compounds across the room).
test("settleEscrowFromPull conserves units exactly on odd budgets", () => {
  const odd = fundedItem({ budgetUnits: 1001 });
  const { item: settled } = settleEscrowFromPull(
    { action: "pr_merged", item: { ...odd, state: "done" }, previousOwnerId: "grok", paths: [] }, { now: NOW });
  const { provider, evaluator, platform } = settled.escrow.split;
  assert.equal(evaluator, 10);
  assert.equal(platform, 10);
  assert.equal(provider, 981);
  assert.equal(provider + evaluator + platform, 1001);
  assert.ok(Number.isInteger(provider) && Number.isInteger(evaluator) && Number.isInteger(platform));
});

// 13. Contract: a closed (unmerged) PR refunds the full budget to the client
// — mirroring settlePullRequest's closed→unclaimed release. Regression: the
// client pays for rejected work (the griefing direction lane-2 failure #1
// warns about, inverted).
test("settleEscrowFromPull refunds the client on close", () => {
  const item = { ...fundedItem(), state: "unclaimed", owner: null };
  const { item: settled, journal } = settleEscrowFromPull(
    { action: "pr_closed", item, previousOwnerId: "grok", paths: [] }, { now: NOW });
  assert.equal(settled.escrow.status, "refunded");
  assert.equal(journal.length, 1);
  assert.equal(journal[0].kind, "escrow_refunded");
  assert.equal(journal[0].units, 1000);
  assert.equal(journal[0].actor, "quill");
});

// 14. Contract: settling an already-settled escrow throws (no double pay).
// Regression: the poll tick and the webhook both settle the same merge and
// the provider is paid twice.
test("settleEscrowFromPull refuses double settlement", () => {
  const released = { ...fundedItem(), state: "done",
    escrow: { ...fundedItem().escrow, status: "released" } };
  throwsCode(() => settleEscrowFromPull({ action: "pr_merged", item: released, previousOwnerId: "grok", paths: [] },
    { now: NOW }), "escrow_not_active");
});

// 15. Contract: lease expiry refunds active escrow (expiry is the only
// liveness primitive — lane-2). Regression: funds stay locked after the
// claim auto-releases, recreating ACP's capital-lockup failure.
test("refundEscrowOnExpiry refunds active escrow and ignores everything else", () => {
  const item = { ...fundedItem(), state: "unclaimed", owner: null };
  const { item: refunded, journal } = refundEscrowOnExpiry(item, { now: NOW });
  assert.equal(refunded.escrow.status, "refunded");
  assert.equal(refunded.escrow.refundReason, "expired");
  assert.equal(journal[0].kind, "escrow_refunded");
  assert.equal(journal[0].units, 1000);
  assert.equal(refundEscrowOnExpiry(legacy, { now: NOW }), null);
  const released = { ...fundedItem(), state: "done", escrow: { ...fundedItem().escrow, status: "released" } };
  assert.equal(refundEscrowOnExpiry(released, { now: NOW }), null);
  const evaluating = seatEvaluation(fundedItem(), "round-7", { now: NOW }).item;
  const expiredEval = refundEscrowOnExpiry({ ...evaluating, state: "unclaimed", owner: null }, { now: NOW });
  assert.equal(expiredEval.item.escrow.status, "refunded");
});

// B2 money-audit: fail-first regression for settleEscrowFromPull releasing
// a never-funded ("offered") escrow on pr_merged.
//
// Contract (from offerEscrow's own docstring): "The budget is encumbered,
// not locked: nothing moves until a worker takes the lease." A pr_merged
// settlement RELEASES the provider/evaluator/platform split — paying real
// (paper) units out of the escrow. Releasing from "offered" mints the split
// from an encumbrance that was never locked.
//
// Invariants:
//   1. pr_merged releases only from funded/locked/evaluating escrow;
//   2. pr_closed refunds from any active escrow (releasing an encumbrance is
//      safe — it is the mirror of offer);
//   3. pr_merged on a funded escrow still releases the exact split
//      (provider + evaluator + platform === budgetUnits).
// Regression: settleEscrowFromPull accepted any ACTIVE_STATUSES status for
// pr_merged, so an offered-but-never-funded escrow settled into a full
// payout split.
import test from "node:test";
import assert from "node:assert/strict";
import {
  EscrowError,
  settleEscrowFromPull,
  offerEscrow,
} from "../server/claim-escrow-adapter.mjs";

const NOW = Date.parse("2026-10-07T12:00:00.000Z");
const throwsCode = (fn, code) =>
  assert.throws(fn, error => error instanceof EscrowError && error.code === code);

const freshClaim = (id = "w-offered") => ({ id, state: "unclaimed", owner: null });

// Build a genuinely offered escrow through the real offer path.
const offeredItem = () => {
  const { item } = offerEscrow(freshClaim(), { budgetUnits: 1000, evaluatorCount: 3 }, { now: NOW });
  return item;
};

test("pr_merged on a never-funded (offered) escrow refuses instead of minting the split", () => {
  const item = { ...offeredItem(), state: "done", owner: "grok" };
  throwsCode(
    () => settleEscrowFromPull({ action: "pr_merged", item }, { now: NOW }),
    "escrow_not_funded",
  );
});

test("pr_closed on an offered escrow still refunds the encumbrance", () => {
  const item = { ...offeredItem(), state: "unclaimed", owner: null };
  const out = settleEscrowFromPull({ action: "pr_closed", item }, { now: NOW });
  assert.equal(out.item.escrow.status, "refunded");
  assert.equal(out.item.escrow.refundReason, "pr_closed");
  assert.equal(out.journal.length, 1);
  assert.equal(out.journal[0].kind, "escrow_refunded");
  assert.equal(out.journal[0].units, 1000);
});

test("pr_merged on a funded escrow still releases the exact split", () => {
  const funded = {
    id: "w-funded", state: "done", owner: "grok",
    escrow: Object.freeze({ status: "funded", budgetUnits: 1000, evaluatorCount: 3,
      evaluatorFeeBps: 100, platformFeeBps: 100, offeredAt: "2026-10-07T11:00:00.000Z",
      offeredBy: "quill", fundedAt: "2026-10-07T11:30:00.000Z", fundedBy: "grok",
      expiresInMs: null }),
  };
  const out = settleEscrowFromPull({ action: "pr_merged", item: funded }, { now: NOW });
  assert.equal(out.item.escrow.status, "released");
  const { provider, evaluator, platform } = out.item.escrow.split;
  assert.equal(evaluator, 10, "1% of 1000");
  assert.equal(platform, 10, "1% of 1000");
  assert.equal(provider, 980);
  assert.equal(provider + evaluator + platform, 1000, "legs always sum to the budget");
  assert.deepEqual(out.journal.map(j => j.kind), [
    "escrow_released_provider", "escrow_released_evaluator", "escrow_released_platform",
  ]);
});

test("pr_merged on an evaluating escrow still releases (the verdict-gated path)", () => {
  const evaluating = {
    id: "w-eval", state: "done", owner: "grok",
    escrow: Object.freeze({ status: "evaluating", budgetUnits: 1000, evaluatorCount: 3,
      evaluatorFeeBps: 100, platformFeeBps: 100, roundId: "round-1",
      offeredAt: "2026-10-07T11:00:00.000Z", offeredBy: "quill",
      fundedAt: "2026-10-07T11:30:00.000Z", fundedBy: "grok", expiresInMs: null }),
  };
  const out = settleEscrowFromPull({ action: "pr_merged", item: evaluating }, { now: NOW });
  assert.equal(out.item.escrow.status, "released");
  const { provider, evaluator, platform } = out.item.escrow.split;
  assert.equal(provider + evaluator + platform, 1000);
});

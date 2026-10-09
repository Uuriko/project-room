// HP-09 (PRODUCT-200 client craft · honest product): fee / take-rate disclosure.
// Regression guard: every number the product shows a human about fees must be
// real (matches the code), current, and honest about what it applies to.
// Change no economics here — this pins disclosure honesty only.
import test from "node:test";
import assert from "node:assert/strict";
import { preparePaidWork } from "../src/paid-work-offers.js";
import { createDisputes, DisputeError } from "../server/bounty-disputes.mjs";
import { FEE_NUMERATOR, FEE_DENOMINATOR } from "../server/bounty-escrow.mjs";

const brief = (overrides = {}) => ({
  requestId: "fee-brief", workItemId: "fee-work",
  accountableMemberId: "producer", humanDecisionMakerId: "owner",
  verifierMemberId: "reviewer", offerId: "research-brief",
  outcome: "Compare inventory reconciliation options",
  acceptanceCriteria: ["Compare three approaches using primary sources"],
  currency: "USD", amountMinor: "10000",
  costsMinor: { labor: "5000", tools: "500", other: "0" },
  platformFeeBps: 200, ...overrides
});

test("paid-work quote marks the platform fee as proposed and reserves nothing", () => {
  const prepared = preparePaidWork(brief());
  const text = prepared.quote.text;
  assert.match(text, /Proposed platform fee, included in total: 200 basis points/);
  assert.match(text, /No funds received or reserved/);
  assert.match(text, /draft quote/);
  assert.equal(prepared.paymentStatus, "not_configured");
  assert.equal(prepared.publicTerms.paymentStatus, "not_configured");
  // The fee math itself is disclosed, not hidden.
  assert.match(text, /\(2\.00 USD; rounded down to asset minor units\)/);
  assert.equal(prepared.quote.feeMinor, "200");
});

test("paid-work quote with zero fee stays honest", () => {
  const prepared = preparePaidWork(brief({ platformFeeBps: 0 }));
  assert.match(prepared.quote.text, /Proposed platform fee, included in total: 0 basis points/);
  assert.equal(prepared.quote.feeMinor, "0");
});

test("the 1% room-pool fee is real: code matches the documented rate", () => {
  // docs/history/FREE-MISS-SETTLEMENT.md + docs/history/bounty-receipts.md say
  // "1% room-pool fee applies on released payouts only", scoped to the valueless
  // credits ledger. Pin the code to the same rate so the docs never drift.
  assert.equal(FEE_NUMERATOR, 1);
  assert.equal(FEE_DENOMINATOR, 100);
});

test("dispute costs are capped at 25% of the bounty (as the design docs state)", () => {
  const d = createDisputes();
  d.open({ disputeId: "D-fee-1", bountyId: "b-1", bountyAmount: 400,
    raisedBy: "challenger", reason: "fee cap honesty check", bond: 20 });
  assert.equal(d.MAX_DISPUTE_COST_RATIO, 0.25);
  assert.equal(d.get("D-fee-1").maxDisputeCost, 100); // 25% of 400
  d.recordCost("D-fee-1", 100); // exactly at the cap: allowed
  assert.throws(() => d.recordCost("D-fee-1", 1), err =>
    err instanceof DisputeError && err.code === "dispute_cost_capped");
});

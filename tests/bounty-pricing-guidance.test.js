// Tests for bounty pricing guidance at post time (#3524):
// server/bounty-pricing-guidance.mjs (the pure computation over settled
// rows) plus the BountyEscrow.pricingGuidance read over real lifecycle
// state. Guidance is derived from SETTLED receipts only — the settlement
// verdict stamped on bounty_records — in the poster's own room.
import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { pricingGuidanceFromSettledRows } from "../server/bounty-pricing-guidance.mjs";
import { BountyEscrow } from "../server/bounty-escrow.mjs";

const settledRow = (workerMillis, { criteria = ["c1"], approvalMode = "human", kind = "verified-complete" } = {}) => ({
  resolution_json: JSON.stringify({ settlement: { kind, workerMillis, workerCredits: workerMillis / 1000, refundMillis: 0, refundCredits: 0, reason: "settled", settledAt: "2026-10-01T00:00:00.000Z", settledBy: { kind: "rule", id: "escrow-keeper" } } }),
  rubric_json: JSON.stringify(criteria.map(id => ({ criterionId: id, description: `criterion ${id}` }))),
  approval_mode: approvalMode,
});

test("guidance: typical paid range comes from settled, paid-out rows only", () => {
  const guidance = pricingGuidanceFromSettledRows([
    settledRow(10_000, { criteria: ["c1"] }),
    settledRow(20_000, { criteria: ["c1", "c2", "c3"] }),
    settledRow(30_500, { criteria: ["c1", "c2"], approvalMode: "agent" }),
  ]);
  assert.equal(guidance.schema, "bounty-pricing-guidance/1");
  assert.equal(guidance.source, "settled-receipts");
  assert.equal(guidance.state, "ok");
  assert.equal(guidance.sampleCount, 3);
  assert.deepEqual(guidance.paidRangeCredits, { min: 10, median: 20, max: 30.5 });
  assert.deepEqual(guidance.rubricCriteriaCount, { min: 1, max: 3 });
  assert.deepEqual(guidance.approvalModes, ["agent", "human"]);
});

test("guidance: median of an even sample is the mean of the middle pair, in whole millis", () => {
  const guidance = pricingGuidanceFromSettledRows([settledRow(10_000), settledRow(10_001)]);
  assert.deepEqual(guidance.paidRangeCredits, { min: 10, median: 10.001, max: 10.001 });
});

test("guidance: cold start returns the plain no-history state with no invented numbers", () => {
  for (const rows of [[], null, undefined, "nope"]) {
    const guidance = pricingGuidanceFromSettledRows(rows);
    assert.equal(guidance.state, "no-settled-history");
    assert.equal(guidance.sampleCount, 0);
    assert.equal(guidance.paidRangeCredits, null);
    assert.equal(guidance.rubricCriteriaCount, null);
    assert.deepEqual(guidance.approvalModes, []);
  }
});

test("guidance: non-settled and settled-at-zero rows are excluded", () => {
  const guidance = pricingGuidanceFromSettledRows([
    { resolution_json: null, rubric_json: null, approval_mode: "human" }, // proposed: no verdict
    { resolution_json: JSON.stringify({ kind: "rejected" }), rubric_json: null, approval_mode: "human" }, // resolution, no settlement
    settledRow(0, { kind: "failed" }), // work judged bad: worker paid 0
    settledRow(0, { kind: "unverified" }), // never verified: worker paid 0
    { resolution_json: "{not json", rubric_json: null, approval_mode: "human" }, // corrupt row: skipped, never throws
    settledRow(5_000),
  ]);
  assert.equal(guidance.state, "ok");
  assert.equal(guidance.sampleCount, 1, "only the settled-and-paid row is a sample");
  assert.deepEqual(guidance.paidRangeCredits, { min: 5, median: 5, max: 5 });
});

test("guidance: accepts already-parsed view shapes (resolution/rubric objects)", () => {
  const guidance = pricingGuidanceFromSettledRows([
    { resolution: { settlement: { kind: "partial", workerMillis: 2_500 } },
      rubric: { criteria: [{ criterionId: "c1" }, { criterionId: "c2" }] }, approvalMode: "agent" },
  ]);
  assert.equal(guidance.sampleCount, 1);
  assert.deepEqual(guidance.paidRangeCredits, { min: 2.5, median: 2.5, max: 2.5 });
  assert.deepEqual(guidance.rubricCriteriaCount, { min: 2, max: 2 });
  assert.deepEqual(guidance.approvalModes, ["agent"]);
});

// --- escrow read: room scoping over real lifecycle state --------------------

const ROOM = "room-guidance";
const OTHER_ROOM = "room-guidance-other";
const JILL = "id:agent/jill";      // poster lane
const GROK = "id:agent/grokbot";   // worker lane

let nowMs = 1_786_000_000_000;
const isoFuture = ms => new Date(nowMs + ms).toISOString();

function makeEscrow() {
  const db = new DatabaseSync(":memory:");
  const transaction = fn => {
    db.exec("SAVEPOINT guidance_test");
    try { const out = fn(); db.exec("RELEASE guidance_test"); return out; }
    catch (error) { db.exec("ROLLBACK TO guidance_test"); db.exec("RELEASE guidance_test"); throw error; }
  };
  const store = { db, transaction, readTransaction: transaction };
  const escrow = new BountyEscrow(store, { now: () => nowMs, allowLegacyStringLanes: true });
  escrow.ensureGenesis(ROOM);
  escrow.ensureGenesis(OTHER_ROOM);
  return { escrow, db };
}

// Post -> fund -> claim -> submit -> accept -> (challenge window) ->
// finalize -> epoch sweep: a bounty that ends PAID with a
// verified-complete settlement paying the worker 99% of the award.
function runToPaid(escrow, roomId, amount) {
  const { bounty } = escrow.postBounty(roomId,
    { poster: JILL, title: "T", criteria: "C", amount, deadline: isoFuture(30 * 24 * 3_600_000) });
  escrow.fundBounty(roomId, bounty.bountyId, { funder: JILL });
  escrow.claimBounty(roomId, bounty.bountyId, { claimant: GROK });
  escrow.submitWork(roomId, bounty.bountyId, { claimant: GROK,
    evidence: { evidenceUrl: "https://example.com/pr/1", summary: "did the thing" } });
  escrow.acceptWork(roomId, bounty.bountyId, { acceptor: JILL,
    verifierAttestation: { at: new Date(nowMs).toISOString(), note: "lgtm", citations: [{ criterionId: "c1", verdict: "pass" }] } });
  nowMs += 3 * 24 * 3_600_000 + 1; // past the challenge window
  escrow.finalizeBounty(roomId, bounty.bountyId, { caller: GROK });
  escrow.closeEpoch(roomId, { caller: JILL });
  return escrow.getBounty(roomId, bounty.bountyId);
}

test("escrow pricingGuidance: a room with no settled bounties is the cold-start state", () => {
  const { escrow } = makeEscrow();
  const guidance = escrow.pricingGuidance(ROOM);
  assert.equal(guidance.state, "no-settled-history");
  assert.equal(guidance.sampleCount, 0);
  assert.equal(guidance.paidRangeCredits, null);
});

test("escrow pricingGuidance: only this room's settled-and-paid bounties count", () => {
  const { escrow } = makeEscrow();
  const paid = runToPaid(escrow, ROOM, 10);
  assert.equal(paid.state, "paid");
  assert.equal(paid.resolution.settlement.kind, "verified-complete");
  runToPaid(escrow, OTHER_ROOM, 90); // settled history in ANOTHER room
  // Non-settled noise in this room: a fresh proposal at a wild amount.
  escrow.postBounty(ROOM, { poster: JILL, title: "T2", criteria: "C2", amount: 500, deadline: isoFuture(3_600_000) });
  const guidance = escrow.pricingGuidance(ROOM);
  assert.equal(guidance.state, "ok");
  assert.equal(guidance.sampleCount, 1, "the other room's settlement and the unsettled proposal are excluded");
  // 10 credits awarded, 1% pool fee on payout: the worker was paid 9.9.
  assert.deepEqual(guidance.paidRangeCredits, { min: 9.9, median: 9.9, max: 9.9 });
  assert.deepEqual(guidance.rubricCriteriaCount, { min: 1, max: 1 });
});

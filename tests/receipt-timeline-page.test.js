// Receipt replay front end (#3523): the public receipt page leads with
// a readable chronological timeline rendered from the receipt record
// itself, and the cryptographic proof (hashes, signed receipt ids) sits
// one click deeper in a <details> block, content unchanged.
//
// Presentation only: no new machinery, no schema change. The fixtures
// below are the shapes receipts already issued carry today
// (project-room-public-receipt/1 as composed by the read model) — no
// fixture gains a field to make the timeline work, which is what
// "works for receipts already issued, no re-minting" means here.
//
// The public record carries dated lifecycle facts (merge, review
// verdict/decision, bounty posting, settlement, the record time),
// a public-work receipt's checks, and a lot's journal movements in
// ledger order with amounts. It does NOT carry individual tool calls,
// commands, or per-step costs outside lot movements; the tests pin
// that the timeline renders what exists and invents none of the rest.
//
// Production seam: the real renderer (server/receipts-page.mjs), real
// receipt shapes, no mocks — the pattern of receipt-detail-honesty.
//
// Run: node --test tests/receipt-timeline-page.test.js
import test from "node:test";
import assert from "node:assert/strict";

import { renderReceiptDetailHtml, receiptTimeline, receiptJson } from "../server/receipts-page.mjs";

// An already-issued server-verified merge receipt: the exact stored
// shape (same fixture family as receipt-detail-honesty.test.js).
const mergedReceipt = {
  schema: "project-room-public-receipt/1",
  id: "wcr_0123456789abcdef0123456789abcdef",
  title: "Fix the needs-attention card overflow",
  source: "work-claim",
  room: { id: "commons", title: "Commons" },
  agents: ["agent-alice"],
  humans: ["Bob"],
  pullRequest: "https://github.com/Uuriko/project-room/pull/2099",
  mergedAt: "2026-10-07T18:00:00.000Z",
  hashes: ["sha256:" + "ab".repeat(32)],
  at: "2026-10-07T18:00:00.000Z",
  startHref: "https://room.trydemigod.com/?start=room",
};

// A reviewed public-work receipt: checks stamped on the record at
// finish, then the reviewer's verdict and decision times (the outcome
// composition of public-read-model.publicWorkReceiptOutcome).
const reviewedWorkReceipt = {
  schema: "project-room-public-receipt/1",
  id: "pwr_" + "cd".repeat(32),
  title: "Public work: write a teardown",
  source: "public-work",
  room: { id: "commons", title: "Commons" },
  agents: ["self-reported-name"],
  humans: [],
  pullRequest: null,
  mergedAt: null,
  hashes: ["sha256:" + "ef".repeat(32)],
  at: "2026-10-07T10:00:00.000Z",
  state: "verified",
  verification: "system_checked",
  checksReported: ["unit: pass"],
  executedChecks: [{ name: "criteria_coverage", result: "pass" }],
  review: {
    state: "accepted",
    verificationVerdict: "PASS",
    verificationReviewerKind: "agent",
    verifiedAt: "2026-10-07T12:00:00.000Z",
    decidedAt: "2026-10-07T13:00:00.000Z",
  },
  startHref: "https://room.trydemigod.com/?start=room",
};

// A settled split lot: bounty posted first, then the lot's journal
// movements in ledger sequence (attribute/approve/refund legs), then
// the settlement — the one receipt shape whose record carries amounts
// in order.
const splitLotReceipt = {
  schema: "project-room-public-receipt/1",
  id: "lot_0123456789abcdef",
  title: "Write the migration guide",
  source: "bounty-lot",
  room: { id: "commons", title: "Commons" },
  agents: [],
  humans: [],
  pullRequest: null,
  mergedAt: null,
  hashes: ["sha256:" + "12".repeat(32)],
  at: "2026-10-08T09:00:00.000Z",
  lot: {
    bountyId: "bty_test",
    kind: "attribute",
    kinds: ["attribute", "approve", "refund"],
    amountMillis: 10000,
    amountCredits: 10,
    from: { account: "id:agent/jill", lotState: "locked" },
    to: { account: "id:agent/grokbot", lotState: "attributed" },
    poster: "id:agent/jill",
    worker: "id:agent/grokbot",
    verifier: null,
    bountyState: "paid",
    awardCredits: 10,
    settlement: {
      kind: "partial",
      workerCredits: 5,
      refundCredits: 5,
      settledAt: "2026-10-08T09:05:00.000Z",
      settledBy: { kind: "agent", id: "id:agent/instinct" },
    },
    movements: [
      { entryId: "e1", kind: "attribute", account: "id:agent/jill", lotState: "locked", amountMillis: -10000 },
      { entryId: "e2", kind: "attribute", account: "id:agent/grokbot", lotState: "attributed", amountMillis: 10000 },
      { entryId: "e3", kind: "approve", account: "id:agent/grokbot", lotState: "attributed", amountMillis: -5000 },
      { entryId: "e4", kind: "approve", account: "id:agent/grokbot", lotState: "approved", amountMillis: 5000 },
      { entryId: "e5", kind: "refund", account: "id:agent/grokbot", lotState: "attributed", amountMillis: -5000 },
      { entryId: "e6", kind: "refund", account: "id:agent/jill", lotState: "payable", amountMillis: 5000 },
    ],
    bountyCreatedAt: "2026-10-06T09:00:00.000Z",
  },
  startHref: "https://room.trydemigod.com/?start=room",
};

test("legacy merged receipt: timeline is merge then record, nothing invented", () => {
  const events = receiptTimeline(mergedReceipt);
  assert.deepEqual(events.map(event => event.kind), ["merged", "recorded"]);
  assert.equal(events[0].at, "2026-10-07T18:00:00.000Z");
  assert.match(events[0].detail, /Pull request #2099/);
  assert.match(events[1].detail, /agent-alice/);
  // No tool calls, commands, or costs exist on this record, and no
  // timeline event pretends otherwise.
  assert.equal(events.some(event => /tool|command|cost/i.test(event.label)), false);
});

test("the page leads with the timeline; the proof sits one click deeper, unchanged", () => {
  const html = renderReceiptDetailHtml(mergedReceipt);
  const timelineAt = html.indexOf('class="receipt-timeline"');
  const proofAt = html.indexOf('<details class="receipt-proof">');
  assert.ok(timelineAt > -1, "timeline section renders");
  assert.ok(proofAt > timelineAt, "proof details come after the timeline");
  assert.ok(html.indexOf("<summary>Proof and record details</summary>") > proofAt,
    "the proof is behind one click (the details summary)");
  assert.ok(html.indexOf("Hash evidence") > proofAt, "hashes moved inside the proof block");
  // Content unchanged: the stored hash and the honesty note are still
  // served verbatim, just inside the details block.
  assert.ok(html.includes("sha256:" + "ab".repeat(32)));
  assert.match(html, /Hashes are stored values, not re-verified/);
  assert.ok(html.indexOf('href="?verify=1"') > -1 && html.indexOf('href="?verify=1"') < proofAt,
    "the verification block stays on the face — it is a verdict, not cryptographic proof");
});

test("reviewed public-work receipt: checks, verdict, and decision land in time order", () => {
  const events = receiptTimeline(reviewedWorkReceipt);
  assert.deepEqual(events.map(event => event.kind),
    ["checks-executed", "checks-reported", "recorded", "review-verified", "review-decided"]);
  assert.deepEqual(events.map(event => event.at), [
    "2026-10-07T10:00:00.000Z", "2026-10-07T10:00:00.000Z", "2026-10-07T10:00:00.000Z",
    "2026-10-07T12:00:00.000Z", "2026-10-07T13:00:00.000Z",
  ]);
  assert.match(events[0].detail, /criteria_coverage — pass/);
  assert.match(events[3].detail, /PASS \(agent reviewer\)/);
  assert.match(events[4].detail, /Verified/);
  const html = renderReceiptDetailHtml(reviewedWorkReceipt);
  assert.ok(html.indexOf("Platform-executed checks") < html.indexOf("Reviewer decision"),
    "the rendered timeline reads chronologically");
});

test("lot receipt: posting, movements with amounts in ledger order, then settlement", () => {
  const events = receiptTimeline(splitLotReceipt);
  assert.deepEqual(events.map(event => event.kind),
    ["bounty-posted", "movement", "movement", "movement", "recorded", "settlement"]);
  assert.match(events[0].detail, /award 10 credits/);
  assert.deepEqual(events.slice(1, 4).map(event => event.label),
    ["Ledger movement: attribute", "Ledger movement: approve", "Ledger movement: refund"]);
  assert.match(events[2].detail, /5000 milli-credits/);
  assert.match(events[5].detail, /worker received 5 credits/);
  assert.match(events[5].detail, /refunded to poster 5 credits/);
  // The record block below the timeline states the same movements the
  // same way (shared grouping/summary, #3765's face).
  const html = renderReceiptDetailHtml(splitLotReceipt);
  assert.ok(html.includes("Movements</dt>"), "the full movements row is still in the record details");
});

test("a receipt with no dated facts still leads with an honest timeline section", () => {
  const bare = { ...mergedReceipt, mergedAt: null, pullRequest: null, at: "not-a-date" };
  assert.deepEqual(receiptTimeline(bare), []);
  const html = renderReceiptDetailHtml(bare);
  assert.ok(html.indexOf('class="receipt-timeline"') > -1);
  assert.match(html, /No dated events are recorded on this receipt/);
});

test("timeline data escapes like every other receipt field", () => {
  const hostile = { ...mergedReceipt, agents: ["<script>alert(1)</script>"] };
  const html = renderReceiptDetailHtml(hostile);
  assert.doesNotMatch(html, /<script>alert\(1\)<\/script>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
});

test("the JSON shape is untouched by the replay front end", () => {
  const json = receiptJson(mergedReceipt);
  assert.equal("timeline" in json, false);
  assert.deepEqual(Object.keys(json).sort(), Object.keys({
    schema: 0, id: 0, title: 0, source: 0, room: 0, agents: 0, humans: 0,
    pullRequest: 0, mergedAt: 0, hashes: 0, at: 0,
  }).sort());
});

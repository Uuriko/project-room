// N1-F1: the verify stamp's headline must carry the delivery outcome.
// The stamp block rendered by ?verify=1 headlined every public-work
// receipt "Record re-checked" — a verified, a submitted, and a rejected
// delivery cropped to the stamp were indistinguishable, even though the
// re-check verdict was honestly identical (it asserts record integrity
// only). Behavior protected:
//   - the headline of a public-work receipt's stamp names its outcome
//     first, then the re-check verdict, so the three outcomes are
//     pairwise distinguishable from the headline alone;
//   - a receipt with no delivery outcome (any non-public-work source)
//     gains no outcome word — its headline is the verdict label alone;
//   - the stamp's stated limits (quality / identity / signature) still
//     appear verbatim — the headline change asserts nothing new.
//
// Run: node --test tests/receipt-stamp-outcome.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { renderVerificationBlock } from "../server/receipts-page.mjs";

const verification = { schema: "project-room-receipt-verification/1", receiptId: "pwr_" + "a".repeat(64),
  checkedAt: "2026-10-29T17:16:53.755Z", verdict: "record-checked", verdictLabel: "Record re-checked",
  summary: "The server re-checked this record just now against its source, and everything it ran still matches.",
  checks: [
    { id: "source-record", label: "Source record", status: "pass",
      detail: "The record was re-derived from its source just now and every field matches." },
    { id: "artifact", label: "Delivered artifact", status: "pass",
      detail: "The stored artifact still hashes to the sha256 this record carries." },
  ],
  scope: { checked: ["Source record", "Delivered artifact"],
    notChecked: [
      "Whether the work itself is any good — no check here judges quality",
      "The real-world identity of the named people — names are as the room recorded them",
      "A signature on this record — public receipts are unsigned, so there is none to check",
    ],
    by: "the Project Room server, at read time" } };

const workReceipt = state => ({ id: "pwr_" + "a".repeat(64), schema: "project-room-public-receipt/1",
  title: "Public task", source: "public-work", state, verification: "hash_only",
  room: { id: "room-1", title: "Room" }, agents: ["worker"], humans: [],
  pullRequest: null, mergedAt: null, hashes: [], at: "2026-10-01T00:00:00.000Z",
  startHref: "https://room.trydemigod.com/?start=room" });

const headlineOf = block => block.match(/<p class="verification-verdict"[^>]*><strong>([^<]*)<\/strong><\/p>/)?.[1];

test("the stamp headline differs by outcome: verified / submitted / rejected", () => {
  const headlines = {
    verified: headlineOf(renderVerificationBlock(workReceipt("verified"), verification)),
    submitted: headlineOf(renderVerificationBlock(workReceipt("submitted"), verification)),
    rejected: headlineOf(renderVerificationBlock(workReceipt("rejected"), verification)),
  };
  assert.equal(headlines.verified, "Verified — Record re-checked");
  assert.equal(headlines.submitted, "Submitted — Record re-checked");
  assert.equal(headlines.rejected, "Rejected — Record re-checked");
  assert.equal(new Set(Object.values(headlines)).size, 3,
    "the three outcomes are pairwise distinguishable from the headline alone");
});

test("a rejected receipt whose re-check passes never headlines as verified", () => {
  const headline = headlineOf(renderVerificationBlock(workReceipt("rejected"), verification));
  assert.ok(headline.startsWith("Rejected"), "the outcome word leads the headline");
  assert.doesNotMatch(headline, /Verified/, "no crop of this stamp can read as a verified delivery");
});

test("a receipt with no delivery outcome gains no outcome word", () => {
  const claim = { ...workReceipt("verified"), source: "work-claim", state: undefined };
  assert.equal(headlineOf(renderVerificationBlock(claim, verification)), "Record re-checked");
  const noState = { ...workReceipt("verified"), state: undefined };
  assert.equal(headlineOf(renderVerificationBlock(noState, verification)), "Record re-checked");
});

test("the stamp's stated limits stay verbatim", () => {
  const block = renderVerificationBlock(workReceipt("rejected"), verification);
  for (const limit of verification.scope.notChecked) {
    assert.ok(block.includes(limit), `limit stays: ${limit}`);
  }
  assert.ok(block.includes(verification.summary), "the summary line is unchanged");
});

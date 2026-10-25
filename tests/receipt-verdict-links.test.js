// Claim → source links at phrase level (charter Workstream B slice 3;
// proof-ux R3). Behavior protected: the words in a verification detail
// that name the pull request link to the pull request itself — the
// checkable source — and the record's pull-request row names the claim
// as its link text. Links form only from a pull URL the record carries;
// a receipt without one gains no fabricated links, and room-controlled
// text in a detail stays escaped around the link.
// Run: node --test tests/receipt-verdict-links.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { renderReceiptDetailHtml, renderVerificationBlock } from "../server/receipts-page.mjs";

const PR_URL = "https://github.com/Uuriko/project-room/pull/2099";
const receipt = { id: "wcr_" + "a".repeat(32), schema: "project-room-public-receipt/1",
  title: "Done work", source: "work-claim", room: null, agents: ["owner"], humans: [],
  pullRequest: PR_URL, mergedAt: "2026-10-01T00:00:00.000Z", hashes: [], at: "2026-10-01T00:00:00.000Z",
  startHref: "https://room.trydemigod.com/?start=room" };
const verification = { schema: "project-room-receipt-verification/1", receiptId: receipt.id,
  checkedAt: "2026-10-15T12:00:00.000Z", verdict: "server-verified", verdictLabel: "Server-verified",
  summary: "S", checks: [
    { id: "source-record", label: "Source record", status: "pass", detail: "The record still matches its source." },
    { id: "pull-request", label: "Pull request on GitHub", status: "pass",
      detail: "GitHub reports pull request #2099 merged at 2026-10-01T00:00:00.000Z (merge commit aaaaaaaaaaaa)." },
  ],
  scope: { checked: ["Source record", "Pull request on GitHub"], notChecked: ["Nothing else"],
    by: "the Project Room server, at read time" } };

test("the pull phrase inside the verdict detail links to the pull request", () => {
  const block = renderVerificationBlock(receipt, verification);
  assert.ok(block.includes(`<a href="${PR_URL}">pull request #2099</a>`),
    "the claim phrase is the link, pointing at the checkable source");
  assert.match(block, /GitHub reports <a href=/, "the link sits inside the sentence that makes the claim");
});

test("the record's pull-request row names the claim as its link text", () => {
  const html = renderReceiptDetailHtml(receipt, { verification });
  assert.ok(html.includes(`<a href="${PR_URL}">Pull request #2099</a>`));
});

test("no pull URL on the record, no fabricated links", () => {
  const lotReceipt = { ...receipt, id: "lot_0123456789abcdef", source: "bounty-lot", pullRequest: null, mergedAt: null };
  const lotVerification = { ...verification, checks: [
    { id: "journal", label: "Escrow journal", status: "pass", detail: "2 entries re-hashed; every hash and chain link still matches." }] };
  const block = renderVerificationBlock(lotReceipt, lotVerification);
  assert.doesNotMatch(block, /<a href=.*pull/, "the journal verdict invents no pull link");
  const html = renderReceiptDetailHtml(lotReceipt, { verification: lotVerification });
  assert.doesNotMatch(html, /Pull request #/, "the record grows no pull row it does not carry");
});

test("room-controlled text in a detail stays escaped around the link", () => {
  const nasty = { ...verification, checks: [
    { id: "source-record", label: "Source record", status: "contradicted",
      detail: 'The record no longer matches its source (title: stored "<script>alert(1)</script>", source "x").' },
    verification.checks[1]] };
  const block = renderVerificationBlock(receipt, nasty);
  assert.doesNotMatch(block, /<script>alert/, "stored titles cannot inject markup");
  assert.match(block, /&lt;script&gt;/);
  assert.ok(block.includes(`<a href="${PR_URL}">pull request #2099</a>`), "the honest link still forms");
});

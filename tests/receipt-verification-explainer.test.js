// AEO Lane 3 (2026-10-17): the receipt verification model passage.
// Wording is pinned against server/receipt-verify.mjs (verifyPublicReceipt):
// the read-time checks, the five verdicts, and the never-checked scope.
import test from "node:test";
import assert from "node:assert/strict";
import {
  renderReceiptsHtml, renderReceiptDetailHtml, receiptVerificationExplainerHtml, RECEIPT_VERIFICATION_FAQ,
} from "../server/receipts-page.mjs";

test("the explainer states the model: stored values until a read-time re-check runs", () => {
  const html = receiptVerificationExplainerHtml();
  for (const needle of [
    "stored values", "not re-verified while you read", "unsigned",
    "re-derives the record from its source", "hash-chain link", "re-fetches that pull request from GitHub",
    "Server-verified", "Record re-checked", "Partially verifiable", "Contradicted", "No longer verifiable",
    "Self-attested", "Hash only", "without an account",
  ]) assert.ok(html.includes(needle), `explainer missing: ${needle}`);
});

test("the receipts index carries the explainer and FAQPage JSON-LD generated from the same Q&A", () => {
  const html = renderReceiptsHtml({ receipts: [] });
  assert.ok(html.includes('id="how-verification-works"'), "explainer section on the index");
  const block = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/.exec(html);
  assert.ok(block, "JSON-LD present on the index");
  const ld = JSON.parse(block[1].replaceAll("\\u003c", "<").replaceAll("\\u003e", ">").replaceAll("\\u0026", "&"));
  assert.equal(ld["@type"], "FAQPage");
  assert.equal(ld.mainEntity.length, RECEIPT_VERIFICATION_FAQ.length);
  for (const [index, entry] of ld.mainEntity.entries()) {
    assert.equal(entry.name, RECEIPT_VERIFICATION_FAQ[index].q);
    assert.equal(entry.acceptedAnswer.text, RECEIPT_VERIFICATION_FAQ[index].a);
  }
});

test("a receipt detail links the explainer from its verification block", () => {
  const html = renderReceiptDetailHtml({
    schema: "project-room-public-receipt/1", id: "wcr_room_claim1", title: "T", source: "work-claim",
    room: { id: "commons", title: "Commons" }, agents: [], humans: [], pullRequest: null, mergedAt: null,
    hashes: [], at: "2026-10-07T18:00:00.000Z", startHref: "https://room.trydemigod.com/?start=room",
  });
  assert.ok(html.includes('href="/receipts#how-verification-works"'), "detail links how-verification-works");
});

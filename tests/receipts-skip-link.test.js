// MI-014 / MI-015 (Jill master-issues): /receipts and receipt detail get a
// skip link to a focusable main, and visible focus styling of their own.
import test from "node:test";
import assert from "node:assert/strict";
import { renderReceiptsHtml, renderReceiptDetailHtml } from "../server/receipts-page.mjs";

const list = renderReceiptsHtml({ generatedAt: "2026-10-01T00:00:00.000Z", board: "board", boardUrl: null,
  commentsScanned: 0, upstreamMain: null, totals: { receipts: 0, verified: 0, failed: 0, open: 0, reported: 0 },
  perLane: [], receipts: [] });
const detail = renderReceiptDetailHtml({ id: "wcr_x", title: "T", at: "2026-10-15T00:00:00.000Z", agents: [], humans: [], startHref: "/" });

for (const [name, html] of [["list", list], ["detail", detail]]) {
  test(`receipts ${name}: skip link is first in body and targets a focusable main`, () => {
    assert.match(html, /<body><a class="skip-link" href="#main">Skip to content<\/a>/);
    assert.match(html, /<main id="main" tabindex="-1">/);
    assert.match(html, /a:focus-visible[^{]*\{outline:2px solid/);
  });
}

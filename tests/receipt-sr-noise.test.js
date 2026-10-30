// MI-022 (Jill master-issues): receipt detail screen-reader noise.
import test from "node:test";
import assert from "node:assert/strict";
import { renderReceiptDetailHtml } from "../server/receipts-page.mjs";

const html = renderReceiptDetailHtml({ id: "wcr_x", title: "A long receipt title that the page already shows as its heading",
  at: "2026-10-15T00:00:00.000Z", agents: [], humans: [], startHref: "/" });

test("empty participant lists read 'none', not an em dash", () => {
  assert.doesNotMatch(html, /<dd>—<\/dd>/);
});

test("badge alt does not repeat the title", () => {
  const alt = html.match(/<img [^>]*alt="([^"]*)"/)?.[1] ?? "";
  if (alt) {
    assert.doesNotMatch(alt, /A long receipt title/);
    assert.match(alt, /^Project Room receipt badge/);
  }
});

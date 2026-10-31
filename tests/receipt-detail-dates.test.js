// MI-021 (Jill master-issues): receipt detail showed raw ISO timestamps.
import test from "node:test";
import assert from "node:assert/strict";
import { renderReceiptDetailHtml, readableUtc } from "../server/receipts-page.mjs";

test("receipt detail shows readable UTC-labelled times, raw ISO only in datetime", () => {
  const html = renderReceiptDetailHtml({ id: "wcr_x", title: "T", at: "2026-10-15T09:05:00.000Z",
    mergedAt: "2026-10-16T18:30:00.000Z", pullRequest: "https://github.com/Uuriko/project-room/pull/1",
    agents: [], humans: [], startHref: "/" });
  assert.match(html, /<time datetime="2026-10-15T09:05:00.000Z">Oct 15, 2026, 09:05 UTC<\/time>/);
  assert.match(html, /<time datetime="2026-10-16T18:30:00.000Z">Oct 16, 2026, 18:30 UTC<\/time>/);
  assert.equal(readableUtc("not a date"), "not a date");
});

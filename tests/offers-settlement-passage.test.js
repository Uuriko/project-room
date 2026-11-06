// AEO Lane 3 (2026-10-17): /offers must answer "how does paid work settle"
// server-rendered. Before this, the page was a JS shell ("Loading
// offers…") and no live page mentioned escrow at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../offers.html", import.meta.url)), "utf8");

test("/offers carries the server-rendered settlement passage with every step", () => {
  assert.match(html, /How paid work settles/, "passage heading");
  for (const needle of ["not a funded bounty", "not configured", "submission is not acceptance", "challenge window", "settlement keeper", "not cash", "no cash-out", "public receipt"]) {
    assert.ok(html.includes(needle), `/offers passage missing: ${needle}`);
  }
  // A-01 single story (wave-2900 D5a): publishing an offer locks nothing,
  // but enabling a credit-reward offer as a public task DOES lock escrow —
  // server/public-work-claims.mjs enable() funds the settlement bounty in
  // the enable transaction (server/public-work-settlement.mjs fund()), so
  // this page must tell the same story as llms-full.txt, not the opposite.
  // project-offers.mjs reports a credit reward's funding as ledger_only;
  // "not configured" is the cash-reward case only.
  assert.ok(html.includes("publishing an offer locks nothing"), "offers must state publishing alone locks nothing");
  assert.ok(html.includes("locked in escrow from the poster"), "offers must state the escrow lock at public-task enable");
  assert.ok(html.includes("never listed unfunded"), "offers must state a paid public task is never listed unfunded");
  assert.ok(html.includes("ledger-only"), "offers must state credit funding is ledger-only");
  assert.ok(!html.includes("no credits are locked in escrow when an offer is enabled"), "the stale no-escrow-at-enable claim must not return");
  // The passage is static HTML above the JS-driven list, not script text.
  const passageAt = html.indexOf("How paid work settles");
  assert.ok(passageAt > 0 && passageAt < html.indexOf("offer-list"), "passage precedes the JS offer list");
});

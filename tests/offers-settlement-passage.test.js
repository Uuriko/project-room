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
  // ATLAS-PUBLIC P-5: an offer locks no escrow — project-offers reports a
  // credit reward's funding as not configured. The escrow-at-enable claim
  // belongs to in-room bounties and must not come back onto this page.
  assert.ok(!html.includes("locked in escrow from their existing balance when the offer is enabled"), "offers must not promise escrow at enable");
  assert.ok(!html.includes("never listed unfunded"), "the never-unfunded claim is the bounty surface's, not the offers page's");
  // The passage is static HTML above the JS-driven list, not script text.
  const passageAt = html.indexOf("How paid work settles");
  assert.ok(passageAt > 0 && passageAt < html.indexOf("offer-list"), "passage precedes the JS offer list");
});

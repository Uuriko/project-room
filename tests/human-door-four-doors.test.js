// PRODUCT-200 client-craft HD-03 (four-door brand pileup). QA-200 found four
// competing entry doors/brands piled up on the human path: Demigod recruiting
// jobs (www.trydemigod.com), the $dasha coin page (getdasha.com), Project Room
// itself (room.trydemigod.com), and Dasha Compute (getdasha.com/compute). A
// human cannot tell which "Demigod" product earns money or what this site is
// versus the other three.
//
// Consolidation contract (the three sibling doors are separate properties,
// not this repo — so this repo consolidates from the room side):
// - index.html stays the one clear primary door (Project Room); minimalism
//   contracts in tests/static-hero-nojs.test.js and
//   tests/human-onboarding-doors.test.js forbid adding education there.
// - about.html becomes the door-clarifier: it names all three sibling doors,
//   says who each is for, links each at its public URL, and carries the
//   honest money line verbatim in spirit.
// - offers.html (money-adjacent surface) carries the honest payout line.
//
// The server serves these files from disk verbatim, so served bytes are the
// contract and a dropped line fails here exactly when the pileup recurs.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const about = readFileSync(fileURLToPath(new URL("../about.html", import.meta.url)), "utf8");
const offers = readFileSync(fileURLToPath(new URL("../offers.html", import.meta.url)), "utf8");
const index = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

const HONEST_MONEY = /reputation receipts/i;

test("about.html names and links all three sibling doors", () => {
  const door = about.match(/<h2 id="which-door">[\s\S]*?(?=<h2|<footer)/)?.[0]
    ?? assert.fail("about.html must carry a #which-door section before the footer");
  assert.ok(door.includes('href="https://www.trydemigod.com/"'), "links the Demigod recruiting door");
  assert.ok(door.includes('href="https://www.getdasha.com/compute/"'), "links the Dasha Compute door");
  assert.ok(door.includes('href="https://www.getdasha.com/"'), "links the $dasha coin door");
});

test("about.html tells a stranger who each door is for, honestly", () => {
  const door = about.match(/<h2 id="which-door">[\s\S]*?(?=<h2|<footer)/)?.[0] ?? "";
  assert.ok(/recruiting/i.test(door) && /talent pays nothing/i.test(door),
    "jobs door: recruiting, who pays");
  assert.ok(/credits are not money/i.test(door),
    "compute door: credits are not money");
  assert.ok(/separate from compute credits|not.*compute credits/i.test(door),
    "coin door: distinct from compute credits");
});

test("about.html carries the honest money line and keeps the onboarding door open", () => {
  assert.match(about, HONEST_MONEY, "honest money sentence present");
  assert.match(about, /cash comes later/i, "honest money sentence complete");
  // Backward compat: the onboarding section the room links at must survive.
  assert.match(about, /id="onboarding"/, "onboarding anchor still present");
  assert.match(about, /New here\? Start here/, "onboarding heading still present");
  assert.ok(about.includes('href="https://github.com/Uuriko/project-room/blob/main/docs/HUMAN-ONBOARDING.md"'),
    "full human guide link still present");
});

test("offers.html carries the honest payout line on its money-adjacent intro", () => {
  const intro = offers.match(/<section class="intro"[\s\S]*?<\/section>/)?.[0]
    ?? assert.fail("offers.html must keep its intro section");
  assert.match(intro, HONEST_MONEY, "honest payout sentence in the intro");
  assert.match(intro, /cash comes later/i, "honest payout sentence complete");
});

test("index.html stays the one primary door (singular brand, no sibling-door clutter)", () => {
  assert.match(index, /<title>Project Room<\/title>/, "title stays the primary door");
  assert.ok(!index.includes("getdasha.com"), "no sibling-door links on the primary door");
  assert.ok(!index.includes("www.trydemigod.com"), "no sibling-door links on the primary door");
});

// M-07 (mobile touch): the composer's Send control is the one action a person
// taps to send a message. At 390 it measured 44x36 (bounding box, runs
// 2026-10-12 12:0x MST on af0c86a94): 36px tall, under the 44px touch-target
// rule. The grid also gives the submit column only 40px, so a 44px-wide
// button would clip. This test pins the rule to the CSS so a future layout
// change cannot silently shrink the primary action's touch target again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

function ruleBody(selector) {
  // Return the declarations of every rule matching the selector text.
  const out = [];
  const re = new RegExp(selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}", "g");
  let m; while ((m = re.exec(css))) out.push(m[1]);
  return out;
}

test("composer Send control has a 44px touch target", () => {
  const bodies = ruleBody('.composer-row > button[type="submit"]');
  assert.ok(bodies.length >= 1, "the .composer-row submit-button rule exists");
  const joined = bodies.join(";");
  assert.match(joined, /min-height:\s*44px/, "submit button declares min-height: 44px");
  assert.match(joined, /min-width:\s*44px/, "submit button declares min-width: 44px");
});

function submitTrackMinimum(columns) {
  // Whitespace inside a CSS math function does not separate grid tracks.
  const track = columns.trim().match(/(?:max\([^()]+\)|[^\s()]+)\s*$/)?.[0].trim();
  if (/^\d+(?:\.\d+)?px$/.test(track ?? "")) return Number.parseFloat(track);
  if (/^max\([^()]+\)$/.test(track ?? "")) {
    const pixels = track.slice(4, -1).split(",").map(value => value.trim())
      .filter(value => /^\d+(?:\.\d+)?px$/.test(value)).map(Number.parseFloat);
    if (pixels.length) return Math.max(...pixels);
  }
  return NaN; // An unfamiliar expression needs review, not an implicit pass.
}

test("composer track guard recognizes CSS math without confusing rem with px", () => {
  assert.equal(submitTrackMinimum("minmax(0, 1fr) max(44px, 2.75rem)"), 44);
  assert.equal(submitTrackMinimum("minmax(0, 1fr) 40px"), 40);
  assert.equal(submitTrackMinimum("1fr max(40px, 2rem)"), 40);
  assert.ok(Number.isNaN(submitTrackMinimum("1fr var(--send-width)")));
});

test("composer grid gives the submit column room for the 44px button", () => {
  const rows = ruleBody(".composer-row")
    .filter((b) => /grid-template-columns/.test(b))
    .map((b) => b.match(/grid-template-columns:\s*([^;]+);/)[1]);
  assert.ok(rows.length >= 1, "at least one .composer-row grid rule exists");
  for (const cols of rows) {
    const px = submitTrackMinimum(cols);
    assert.ok(Number.isFinite(px) && px >= 44, `submit track in "${cols}" guarantees room for a 44px control`);
  }
});

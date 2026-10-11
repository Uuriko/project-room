// One-shot done-chip motion vs card re-mount (wave500-g8-a11y-06).
//
// Fail-first: the done-chip pop is a one-shot for the terminal state change.
// Folded updates re-render (re-mount) whole cards, message sections, and the
// presence list via innerHTML swaps; because the animation was bound to the
// .done-chip class itself, every re-mount replayed the pop. The guard is
// settleDoneChipReplay(previousHtml, nextHtml): when the chip was already
// shown before the re-mount, the returned markup carries the settled marker
// and CSS skips the animation. A genuinely new chip (the actual transition)
// keeps the one-shot.
//
// Authoring-gate answers:
// 1. Behavior: one-shot pop plays on the terminal transition only, never on a
//    re-mount of an already-shown chip.
// 2. Regression: the guard is removed or bypassed -> re-mount markup keeps a
//    bare animated chip -> the pop replays on every folded update.
// 3. Existing coverage: tests/done-chip.test.js owns chip presence/absence in
//    rendered HTML; nothing covers the re-mount boundary. This owns the
//    mount-gating contract at its testable owner boundary (app.js cannot be
//    imported in node: module-level browser side effects).
// 4. No test-only seam: the helper is called by production app.js re-mount
//    sites; the marker class is consumed by production CSS.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  doneChip,
  settleDoneChipReplay,
  DONE_CHIP_SETTLED_CLASS,
} from "../src/workflow.js";

const done = {
  state: "completed", ownerDecisionRequired: false,
  receipt: { eventId: "e1", evidenceVersion: 1 }, verification: null,
  independentVerificationRequired: false,
};
const chip = doneChip(done);
assert.ok(chip.includes('class="done-chip"'), "fixture sanity: real chip markup");

// A card whose only change is unrelated content (a folded update), with the
// chip already shown before and after the re-mount.
const cardBefore = `<article class="work-card"><div class="work-card-header">${chip}</div><h3>Ship it</h3><p>attempts: 1</p></article>`;
const cardAfter = `<article class="work-card"><div class="work-card-header">${chip}</div><h3>Ship it</h3><p>attempts: 2</p></article>`;

// A card where the item just reached terminal state: no chip before.
const cardWorking = `<article class="work-card"><div class="work-card-header"></div><h3>Ship it</h3></article>`;

test("re-mount of an already-shown chip marks it settled (no replay)", () => {
  const next = settleDoneChipReplay(cardBefore, cardAfter);
  assert.ok(next.includes(DONE_CHIP_SETTLED_CLASS), "settled marker added");
  assert.ok(!next.includes('class="done-chip"'), "no bare animated chip remains");
  assert.ok(next.includes("attempts: 2"), "unrelated update content preserved");
});

test("first appearance of the chip keeps the one-shot (actual state change)", () => {
  const next = settleDoneChipReplay(cardWorking, cardAfter);
  assert.equal(next, cardAfter, "markup untouched: the pop still plays on transition");
  assert.ok(!next.includes(DONE_CHIP_SETTLED_CLASS), "no settled marker on a new chip");
});

test("no chip in either markup passes through untouched", () => {
  assert.equal(settleDoneChipReplay(cardWorking, cardWorking), cardWorking);
});

test("chip removed in the next markup stays removed", () => {
  assert.equal(settleDoneChipReplay(cardBefore, cardWorking), cardWorking);
});

test("first mount (no previous markup) keeps the animation", () => {
  assert.equal(settleDoneChipReplay(undefined, cardAfter), cardAfter);
  assert.equal(settleDoneChipReplay("", cardAfter), cardAfter);
});

test("every chip in the next markup is settled, not just the first", () => {
  const two = `${chip}<div class="message-links">${chip}</div>`;
  const next = settleDoneChipReplay(two, two);
  assert.ok(!next.includes('class="done-chip"'), "no bare chip remains");
  assert.equal(next.split(DONE_CHIP_SETTLED_CLASS).length - 1, 2, "both chips settled");
});

test("CSS pairs the settled marker with animation:none (JS<->CSS contract)", () => {
  // Source inspection is the cheapest independent guard here: if the CSS rule
  // is deleted or the marker renamed on one side, the replay silently
  // returns and no JS-only test can catch it. Fails when the contract
  // changes; survives identifier-only refactors of unrelated CSS.
  const here = dirname(fileURLToPath(import.meta.url));
  const css = readFileSync(join(here, "..", "src", "styles.css"), "utf8");
  const rule = /\.done-chip[^{}]*\.done-chip--settled\s*\{[^}]*\}/.exec(css);
  assert.ok(rule, "a settled-chip rule exists in styles.css");
  assert.match(rule[0], /animation\s*:\s*none/, "settled chips skip the animation");
});

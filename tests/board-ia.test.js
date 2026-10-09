// BU-10 information-architecture contracts: the board must speak one vocabulary.
// A newcomer predicts where things are from the words on the buttons; when an
// action verb ("Done") disagrees with the column it lands in ("Landed"), or the
// creation form says "item" while everything else says "claim", the board feels
// unpredictable. These are the cheapest independent guards for those user-facing
// string contracts: they fail when the contract changes and survive an
// identifier-only refactor (they assert rendered literals, not variable names).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const boardUi = readFileSync(new URL("../src/board-ui.js", import.meta.url), "utf8");
const appJs = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");

test("terminal column label matches the Done action verb (no Done/Landed split)", () => {
  // The card action is labeled "Done" and the committed state is "done"; the
  // column it lands in must say "Done" too, or a newcomer loses their card.
  assert.match(boardUi, /\["landed",\s*"Done"\]/, 'expected the landed column to be labeled "Done"');
  assert.ok(!boardUi.includes('"Landed"'), 'human-visible "Landed" label still present');
  assert.match(boardUi, /button\("done",\s*"Done"/, 'expected the done action button to be labeled "Done"');
});

test("creation form uses claim vocabulary, not item vocabulary", () => {
  // Everything else on the board says claim/work claim ("Claim work here",
  // "Claim" button). The creation form must not invent a third noun.
  assert.match(boardUi, /<h3>New claim<\/h3>/, 'expected the creation form heading "New claim"');
  assert.match(boardUi, />Add claim<\/button>/, 'expected the creation submit button "Add claim"');
  assert.ok(!boardUi.includes(">New item<"), 'human-visible "New item" still present');
  assert.ok(!boardUi.includes(">Add item<"), 'human-visible "Add item" still present');
});

test("blocked header count names what it counts", () => {
  // The Blocked column mixes owner-marked-blocked cards with cards auto-sorted
  // here for unmet prerequisites. The header count only covers the latter, so
  // it must say so — bare "N waiting" reads as the whole column waiting.
  assert.match(boardUi, /waiting on prerequisites/, 'expected the blocked header count to name prerequisites');
});

test("in-review column states its population rule", () => {
  // Nothing on a card is called "review" — the column is fed automatically by
  // linked pull requests. A newcomer must be able to learn that from the board,
  // so the column render itself must carry the rule.
  const caption = "Claims with a linked pull request appear here.";
  assert.ok(boardUi.includes(caption), "expected an In-review population-rule caption");
  const mapAt = boardUi.indexOf("COLUMNS.map");
  assert.ok(mapAt !== -1 && mapAt < boardUi.indexOf(caption), "caption is not wired into the column render");
});

test("command palette finds the board through the word work", () => {
  // A newcomer thinking "where is the work?" types "work". The palette must
  // surface the board — not just the "New work" composer (which creates a work
  // item, a different object than a work claim).
  const entry = /\{\s*id:\s*"board",\s*label:\s*"([^"]+)",\s*words:\s*"([^"]+)"[^}]*\}/.exec(appJs);
  assert.ok(entry, "board palette entry not found in src/app.js");
  const [, label, words] = entry;
  assert.equal(label, "Work board", `unexpected board palette label: ${label}`);
  assert.ok(words.split(" ").includes("work"), `board palette keywords miss "work": ${words}`);
});

test("older-work hint is human, not API jargon", () => {
  // "Older landed work is in the API" names an interface, not a destination a
  // human can act on. State the actual rule: finished >1 week ago is hidden.
  assert.ok(!boardUi.includes("is in the API"), '"is in the API" hint still present');
  assert.match(boardUi, /more than a week ago/i, "expected the older-work hint to state the one-week rule");
});

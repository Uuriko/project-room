// M-02 mobile claim→finish journey (390px/375px viewports): the Board UI's
// touch targets and card overflow on phones. #2034 set the 44px coarse-pointer
// floor; the Board's two <summary> disclosures and the Tasks-nav Squads entry
// fell through it, and long PR URLs / repo@branch strings overflow the claim
// card on narrow viewports (sibling elements already carry overflow-wrap).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/board.css", import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, ""); // comments glue onto the next selector

// All declaration blocks whose selector list contains the target selector,
// joined: a rule may be split across a combined selector and a later rule.
function declarationsFor(selector) {
  const out = [];
  for (const chunk of css.split("}")) {
    const i = chunk.indexOf("{");
    if (i === -1) continue;
    const selectors = chunk.slice(0, i).split(",").map(part => part.trim());
    if (selectors.includes(selector)) out.push(chunk.slice(i + 1));
  }
  return out.join("\n");
}

test("claim file-list disclosures are a 44px touch target", () => {
  const base = declarationsFor(".claim-files summary");
  assert.ok(base.trim(), ".claim-files summary has a rule");
  assert.match(base, /min-height:\s*44px/, "touch target stays 44px");
});

test("needs-me More disclosure is a 44px touch target", () => {
  const base = declarationsFor(".needs-me-more summary");
  assert.ok(base.trim(), ".needs-me-more summary has a rule");
  assert.match(base, /min-height:\s*44px/, "touch target stays 44px (was 32px)");
});

test("long PR and repo strings wrap inside the claim card on 375px", () => {
  const pr = declarationsFor(".claim-pr");
  assert.ok(pr.trim(), ".claim-pr has a rule");
  assert.match(pr, /overflow-wrap:\s*anywhere/, "long PR URLs wrap instead of overflowing the card");
  const repo = declarationsFor(".claim-repo");
  assert.ok(repo.trim(), ".claim-repo has a rule");
  assert.match(repo, /overflow-wrap:\s*anywhere/, "long repo@branch strings wrap instead of overflowing the card");
});

test("the Squads nav entry matches the Board nav-row treatment", () => {
  const base = declarationsFor("#squads-open");
  assert.ok(base.trim(), "#squads-open has a rule");
  assert.match(base, /min-height:\s*44px/, "touch target stays 44px");
  assert.match(base, /background:\s*transparent/, "nav row, not a default grey button");
});

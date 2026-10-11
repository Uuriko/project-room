// WAVE-500 G8-12: horizontal-scroll audit of the Tasks › Board at 360px.
// The board dialog renders at 100vw - 1rem (~344px); two card rows could still
// push it wider than the viewport:
//  1. .claim-owner is a flex row and its name <span> is a flex item with the
//     default min-width:auto — a long unbreakable owner identity (raw member
//     id like ai_AAW8yE9gyFu1_Lbn, or an agent's @-prefixed display name)
//     refuses to shrink and widens the card past the viewport.
//  2. .claim-files <li> rows render raw file paths (e.g.
//     tests/agent-wake-listener-lease.test.js, 40 chars, ~280px at body size
//     against ~224px of content). CSS has no soft wrap opportunity inside a
//     path, so the card scrolls horizontally.
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

test("long unbreakable owner names shrink and wrap inside the claim card at 360px", () => {
  const base = declarationsFor(".claim-owner span");
  assert.ok(base.trim(), ".claim-owner span has a rule");
  assert.match(base, /min-width:\s*0/, "flex item may shrink below its min-content width");
  assert.match(base, /overflow-wrap:\s*anywhere/, "long unbreakable identities wrap instead of widening the card");
});

test("long claim file paths wrap inside the claim card at 360px", () => {
  const base = declarationsFor(".claim-files li");
  assert.ok(base.trim(), ".claim-files li has a rule");
  assert.match(base, /overflow-wrap:\s*anywhere/, "long file paths wrap instead of overflowing the card");
});

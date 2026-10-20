// The Work entry now uses shared topbar styling; browser checks cover its
// visible touch target. The board's owner control still needs its own style.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/board.css", import.meta.url), "utf8");
const rule = selector => {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[#:[\]]/g, m => `\\${m}`)}\\s*[,{]([^}]*)\\}`));
  return match ? match[1] : null;
};

test("the owner Save cap button is styled, not a default button", () => {
  const base = rule("[data-claim-cap] button");
  assert.ok(base, "[data-claim-cap] button has a rule");
  assert.match(base, /background:\s*var\(--panel-raised\)/);
  assert.match(base, /color:\s*var\(--text\)/);
});

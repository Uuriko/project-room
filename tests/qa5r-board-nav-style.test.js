// QA5R-UI-1: the sidebar Board entry (#tasks-board-open) must carry its own
// nav-row style. Without one it falls back to the browser's default grey
// button, unlike every other sidebar row (residue of QA3 F20).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const css = readFileSync(new URL("../src/board.css", import.meta.url), "utf8");
const rule = selector => {
  const match = css.match(new RegExp(`(?:^|\\n)${selector.replace(/[#:]/g, m => `\\${m}`)}\\s*\\{([^}]*)\\}`));
  return match ? match[1] : null;
};

test("the sidebar Board entry is styled as a nav row, not a default button", () => {
  const base = rule("#tasks-board-open");
  assert.ok(base, "#tasks-board-open has a rule");
  assert.match(base, /background:\s*transparent/);
  assert.match(base, /color:\s*var\(--text\)/);
  assert.match(base, /border:\s*0/);
  assert.match(base, /min-height:\s*44px/, "touch target stays 44px");
  assert.ok(rule("#tasks-board-open:hover"), "hover state exists");
});

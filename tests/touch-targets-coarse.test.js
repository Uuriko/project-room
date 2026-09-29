// R11 (QA 2026-09-29): .button (~33px) and .topbar-button (36px) measured
// below the 44px coarse-pointer touch minimum. The fix is a pointer:coarse
// rule; this pins the contract so a later stylesheet edit can't silently
// drop touch devices back under.
//
// The 36px variants (.people-actions .button, .search-row .button) are named
// explicitly: their base rules carry higher specificity than a bare .button,
// so a bare rule would lose to them on coarse pointers.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");

function coarseCss(cssText) {
  const out = [];
  const re = /@media\s*\(\s*pointer\s*:\s*coarse\s*\)\s*\{/g;
  let m;
  while ((m = re.exec(cssText))) {
    let depth = 1, i = re.lastIndex;
    while (i < cssText.length && depth > 0) {
      if (cssText[i] === "{") depth++;
      else if (cssText[i] === "}") depth--;
      i++;
    }
    out.push(cssText.slice(m.index, i));
  }
  return out.join("\n");
}

const coarse = coarseCss(css);
assert.ok(coarse.length > 0, "expected at least one pointer:coarse block in styles.css");

for (const selector of [".button", ".topbar-button", ".people-actions .button", ".search-row .button"]) {
  test(`coarse pointers: ${selector} reaches the 44px touch minimum`, () => {
    const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const covered = rules.some(([, selectors, declarations]) =>
      selectors.split(",").map(s => s.trim()).includes(selector)
      && /min-height\s*:\s*44px/.test(declarations));
    assert.ok(covered, `${selector} has no coarse-pointer rule setting min-height: 44px`);
  });
}

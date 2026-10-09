// PRODUCT-200 M-07: mobile touch floor on the offers page.
//
// offers.html loads only src/project-offers.css, so #2034's coarse-pointer
// 44px floor (which lives in src/styles.css) never reached this page. A
// static audit of every interactive element at a 375px mobile viewport found
// three taps under the floor on coarse pointers:
//
//  1. `.prompt-disclosure summary` ("Read the agent prompt", offer detail):
//     `padding:10px 0` at 13px text -> ~39px tall box.
//  2. `#find-work-results summary` ("Read claim instructions", match rows):
//     no rule at all -> browser-default single line-height (~19px).
//  3. `.brand` (header home nav link): 21px text at inherited 1.5
//     line-height -> ~31.5px; the sibling `.room-link` already floors at 44px.
//
// Everything else already meets the floor: .primary/.secondary (46px),
// .text-button (44px: #refresh-offers, .detail-close, #retry-brief,
// #more-matches, match-title buttons), .offer-card (full card),
// .find-work input/select (44px). Footer and .scope-links are
// inline-in-sentence links, deliberately not floored (same exemption as
// PRODUCT-200 BU-04). The fix is a pointer:coarse block so fine-pointer
// desktop layout is untouched.
//
// Authoring gate: guards the #2034 coarse-pointer contract on this page's
// disclosure toggles + header nav (no existing test covers
// project-offers.css; tests/touch-targets-coarse.test.js is BU-04's and
// covers styles.css). A later stylesheet edit that drops the coarse block or
// re-shrinks one of these selectors makes the named assertion fail. Follows
// the established static-CSS pattern (source inspection as the cheapest
// independent guard); no live browser in this lane.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const css = readFileSync(fileURLToPath(new URL("../src/project-offers.css", import.meta.url)), "utf8");

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

for (const selector of [".prompt-disclosure summary", "#find-work-results summary", ".brand"]) {
  test(`coarse pointers: offers page ${selector} reaches the 44px touch minimum`, () => {
    assert.ok(coarse.length > 0, "expected at least one pointer:coarse block in project-offers.css");
    const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const covered = rules.some(([, selectors, declarations]) =>
      selectors.split(",").map(s => s.trim()).includes(selector)
      && /min-height\s*:\s*44px/.test(declarations));
    assert.ok(covered, `${selector} has no coarse-pointer rule setting min-height: 44px`);
  });
}

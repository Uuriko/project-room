// WAVE-500 guild 8 worker 7: touch-target audit (44px floor).
//
// Interactive elements are measured from the CSS cascade itself (real
// declarations, not guesses): for each selector the LAST base (non-@media)
// rule that declares min-height wins at equal-or-lower specificity, and rem
// is resolved against the 16px root. Elements that the codebase deliberately
// keeps small on fine pointers (hover-reveal message links, inline-in-sentence
// links, raw checkbox inputs inside 44px label rows, .reactions under
// (hover:hover)/(pointer:fine), coarse-pointer floors that already exist)
// are intentionally NOT asserted here — the contract is the 44px floor for
// controls a finger actually taps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
// Strip comments: braces inside comments confuse the brace-walking parser.
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const styles = stripComments(readFileSync(join(ROOT, "src", "styles.css"), "utf8"));
const publicA11y = stripComments(readFileSync(join(ROOT, "src", "public-a11y.css"), "utf8"));
const operator = stripComments(readFileSync(join(ROOT, "src", "operator.css"), "utf8"));

// Walk the CSS and collect rule bodies for an exact selector. Only rules at
// the top level (mediaDepth === 0) count as "base" — rules inside @media
// blocks are conditional and measured separately.
function baseRuleBodies(css, selector) {
  const bodies = [];
  let i = 0, n = css.length, mediaDepth = 0;
  while (i < n) {
    if (css.startsWith("@media", i)) {
      // Find the opening brace of the @media header.
      const open = css.indexOf("{", i);
      if (open === -1) break;
      i = open + 1;
      mediaDepth++;
      continue;
    }
    if (css[i] === "{" ) {
      // Rule header ends here; walk back to the selector text.
      let h = i - 1;
      while (h >= 0 && css[h] !== "}" && css[h] !== "{") h--;
      const header = css.slice(h + 1, i).trim();
      // Find matching close brace.
      let depth = 1, j = i + 1;
      while (j < n && depth > 0) {
        if (css[j] === "{") depth++;
        else if (css[j] === "}") depth--;
        j++;
      }
      const body = css.slice(i + 1, j - 1);
      const selectors = header.split(",").map((s) => s.trim());
      if (selectors.includes(selector) && mediaDepth === 0) bodies.push(body);
      i = j;
      continue;
    }
    if (css[i] === "}") {
      if (mediaDepth > 0) mediaDepth--;
      i++;
      continue;
    }
    i++;
  }
  return bodies;
}

function pxValue(raw) {
  const m = /(-?[\d.]+)\s*(px|rem|em)/.exec(raw);
  if (!m) return null;
  const v = parseFloat(m[1]);
  return m[2] === "px" ? v : v * 16;
}

// Effective base min-height for a selector: the last base rule body that
// declares min-height (later rules win the cascade at equal specificity).
function effectiveMinHeight(css, selector) {
  let found = null;
  for (const body of baseRuleBodies(css, selector)) {
    const m = /min-height\s*:\s*([^;]+);?/.exec(body);
    if (m) found = pxValue(m[1]);
  }
  return found;
}

const offenders = [
  // [css, selector, measured-before-fix, why]
  [styles, ".file-chip button", 24, "composer attachment remove button (min-height: 1.5rem beats the base button 44px rule)"],
  [styles, ".composer-row #request-reply", 32, "composer 'Request a reply' button; no coarse-pointer floor exists"],
  [styles, ".invite-navigation .button", 40, "invite panel action buttons; no coarse-pointer floor exists"],
  [styles, ".channel", 40, "sidebar channel nav buttons; no coarse-pointer floor exists"],
  [operator, "button", 36, "operator console buttons (standalone stylesheet)"],
];

for (const [css, selector, , why] of offenders) {
  test(`touch target >= 44px: ${selector}`, () => {
    const px = effectiveMinHeight(css, selector);
    assert.ok(
      px !== null,
      `${selector}: no base min-height declaration found (${why})`,
    );
    assert.ok(
      px >= 44,
      `${selector} measures ${px}px tall at base — below the 44px touch floor (${why})`,
    );
  });
}

// The public-a11y disclosure summaries are intentionally 24px (WCAG 2.5.8 AA
// minimum) on fine pointers, but on coarse pointers they are finger taps and
// must carry the 44px floor — mirroring the BU-04 coarse pattern already in
// styles.css.
const coarseSummaries = [
  "#room-about > summary",
  "#account-settings > summary",
  ".agent-advanced > summary",
  ".agent-invite-instructions > summary",
  ".inbox-gmail summary",
  "#agent-local-client > summary",
];

function coarseBlocks(css) {
  const out = [];
  const starts = [...css.matchAll(/@media[^{]*\{/g)];
  for (const b of starts) {
    if (!/pointer:\s*coarse/.test(b[0])) continue;
    let depth = 0, end = b.index;
    for (let i = b.index; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    out.push(css.slice(b.index, end));
  }
  return out;
}

for (const selector of coarseSummaries) {
  test(`coarse-pointer touch floor: ${selector}`, () => {
    const blocks = coarseBlocks(publicA11y);
    const floored = blocks.some((body) => {
      // Split the block into rules and check any rule whose selector list
      // contains our selector sets min-height: 44px.
      const rules = [...body.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
      return rules.some(([ , header, decls]) => {
        const sels = header.split(",").map((s) => s.trim());
        return sels.includes(selector) && /min-height\s*:\s*44px/.test(decls);
      });
    });
    assert.ok(
      floored,
      `${selector} has no @media (pointer: coarse) 44px floor in public-a11y.css`,
    );
  });
}

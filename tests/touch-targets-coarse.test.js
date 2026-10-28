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

// HD-04 (QA-200 2026-10-08, stranger-mobile): .text-button (back/"more"
// navigation links, ~11px font, padding:0) and .link-button had no
// coarse-pointer floor at all — untappable on phones. Same 44px contract.
// QA-200 challenger ch-2034 (follow-up to PR #2034): the per-message "⋯"
// overflow trigger (.message-more > summary, ~20px) is not a <button>, so the
// global button floor misses it — and on touch it's the only path to the
// message overflow actions. Same 44px contract.
for (const selector of [".button", ".topbar-button", ".people-actions .button", ".search-row .button", ".text-button", ".link-button",
".message-more > summary", ".composer-add"]) {
  test(`coarse pointers: ${selector} reaches the 44px touch minimum`, () => {
    const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const covered = rules.some(([, selectors, declarations]) => {
      if (!selectors.split(",").map(s => s.trim()).includes(selector)) return false;
      const m = declarations.match(/(?:min-height|height)\s*:\s*(\d+)px/);
      return m && Number(m[1]) >= 44;
    });
    assert.ok(covered, `${selector} has no coarse-pointer rule giving it a >=44px height`);
  });
}

// PRODUCT-200 BU-04 (2026-10-08, #2034 follow-through): #2034's .text-button
// floor misses the per-message action buttons — they carry only the
// .message-to-work class, not .text-button, so on coarse pointers they render
// ~11px tall with padding:0. Same for .thread-link in the message row. The two
// "intentional small" 24px contexts (.member-actions, .dm-consent-actions)
// also survive #2034 by higher specificity (0,2,0 beats the bare
// .text-button rule), so they need same-specificity coarse overrides — on a
// phone those are primary consent/member-management taps, not decoration.
for (const selector of [".message-links .message-to-work", ".message-links .thread-link",
".member-actions .text-button", ".dm-consent-actions .text-button"]) {
  test(`coarse pointers: ${selector} reaches the 44px touch minimum`, () => {
    const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const covered = rules.some(([, selectors, declarations]) => {
      if (!selectors.split(",").map(s => s.trim()).includes(selector)) return false;
      const m = declarations.match(/(?:min-height|height)\s*:\s*(\d+)px/);
      return m && Number(m[1]) >= 44;
    });
    assert.ok(covered, `${selector} has no coarse-pointer rule giving it a >=44px height`);
  });
}

// BU-04: disclosure toggles (details > summary) are full-row tap targets on
// the board — people panel, session menu, room creation, inbox, DM consent,
// work-claim cards, and the long-message expander. Their base rules sit at
// 28-36px (or bare text height) with no coarse floor. Same 44px contract.
for (const selector of [".create-room-details summary", ".member-profile-body summary",
".member-directory-card > summary", ".member-profile > summary",
"#connection-details > summary", "#session-menu-panel #connection-details > summary",
".inbox-add-connection summary", ".dm-consent summary",
".claim summary", ".work-more > summary", ".message-expansion > summary"]) {
  test(`coarse pointers: disclosure ${selector} reaches the 44px touch minimum`, () => {
    const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const covered = rules.some(([, selectors, declarations]) => {
      if (!selectors.split(",").map(s => s.trim()).includes(selector)) return false;
      const m = declarations.match(/(?:min-height|height)\s*:\s*(\d+)px/);
      return m && Number(m[1]) >= 44;
    });
    assert.ok(covered, `${selector} has no coarse-pointer rule giving it a >=44px height`);
  });
}

// BU-04: the label-row toggles (.also-send-toggle, .inbox-filters label,
// 32px) are the tap targets around their 18-20px checkboxes — the boxes stay
// intentionally small (see exemption below), so the rows get the floor.
for (const selector of [".also-send-toggle", ".inbox-filters label"]) {
  test(`coarse pointers: ${selector} reaches the 44px touch minimum`, () => {
    const rules = [...coarse.matchAll(/([^{}]+)\{([^{}]*)\}/g)];
    const covered = rules.some(([, selectors, declarations]) => {
      if (!selectors.split(",").map(s => s.trim()).includes(selector)) return false;
      const m = declarations.match(/(?:min-height|height)\s*:\s*(\d+)px/);
      return m && Number(m[1]) >= 44;
    });
    assert.ok(covered, `${selector} has no coarse-pointer rule giving it a >=44px height`);
  });
}

// BU-04: the 24px contextual text-buttons are floored by same-specificity
// overrides placed AFTER the base rules, so the cascade (not just the
// media query) resolves them to 44px on coarse pointers.
for (const selector of [".member-actions .text-button", ".dm-consent-actions .text-button"]) {
  test(`coarse override for ${selector} wins by cascade order`, () => {
    const baseIdx = css.indexOf(selector);
    const coarseRuleIdx = coarse.indexOf(selector);
    assert.ok(baseIdx >= 0, `${selector} base rule missing`);
    assert.ok(coarseRuleIdx >= 0, `${selector} coarse override missing`);
    const coarseBlockIdx = css.indexOf("@media (pointer: coarse)", baseIdx);
    assert.ok(coarseBlockIdx > baseIdx,
      `${selector} coarse override must come after the base 24px rule to win the specificity tie`);
  });
}

// Documented exemption (QA2-A11Y D-fo-3): raw checkbox/radio inputs keep
// their intentional 20px size — the coarse `input` floor loses to the
// higher-specificity .check input rule by design. The label ROWS
// (.also-send-toggle, .inbox-filters label) are floored instead.
test("checkbox inputs keep their intentional 20px size (exempt from the floor)", () => {
  const m = css.match(/\.check input\s*\{([^}]*)\}/);
  assert.ok(m, ".check input rule missing");
  assert.ok(/min-height\s*:\s*20px/.test(m[1]), ".check input should keep min-height: 20px");
});

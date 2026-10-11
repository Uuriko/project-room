// WAVE-500 G1 14/50: sign-in UI at ~360px viewports.
// The agent sign-in "created" view shows the identity ID, secret and
// claim-signing key exactly once, each in a flex row with Show/Copy buttons
// (.agent-secret-row). A flex item's automatic minimum size is its intrinsic
// width (~20ch for these inputs), so without min-width: 0 the row cannot
// shrink: on narrow phones / enlarged text / longer translations the Copy
// button is pushed out of the panel or the page gains a horizontal scrollbar.
// The same overflow class was already fixed for .join-secret-row
// (src/public-a11y.css) and .key-field (src/styles.css); this guards the
// third instance and the surrounding narrow-viewport invariants.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function loadCss(path) {
  return readFileSync(new URL(path, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, ""); // comments glue onto the next selector
}

// Declarations for an exact selector, across stylesheets and one level of
// @media nesting. Later rules append after earlier ones (document order).
function declarationsFor(sheets, selector) {
  const out = [];
  for (const css of sheets) {
    let depth = 0, selectorStart = 0, bodyStart = -1, current = "";
    const flush = (sel, body) => {
      const parts = sel.split(",").map(part => part.trim()).filter(Boolean);
      if (parts.includes(selector)) out.push(body);
    };
    for (let i = 0; i < css.length; i += 1) {
      const ch = css[i];
      if (ch === "{") {
        if (depth === 0 || (depth === 1 && current.trim().startsWith("@media"))) {
          if (depth === 0) current = css.slice(selectorStart, i);
          else current = css.slice(bodyStart, i);
          bodyStart = i + 1;
        }
        depth += 1;
      } else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          flush(current, css.slice(bodyStart, i));
          selectorStart = i + 1; bodyStart = -1; current = "";
        } else if (depth === 1 && current.trim().startsWith("@media")) {
          flush(current, css.slice(bodyStart, i));
          bodyStart = i + 1;
        }
      }
    }
  }
  return out.join("\n");
}

const sheets = [
  loadCss("../src/styles.css"),
  loadCss("../src/login-polish.css"),
  loadCss("../src/public-a11y.css"),
];

test("one-time secret rows shrink instead of overflowing the panel at ~360px", () => {
  const row = declarationsFor(sheets, ".agent-secret-row");
  assert.ok(row.trim(), ".agent-secret-row has a rule");
  assert.match(row, /display:\s*flex/, "secret row lays input + buttons out in flex");
  const input = declarationsFor(sheets, ".agent-secret-row input");
  assert.ok(input.trim(), ".agent-secret-row input has a rule");
  assert.match(input, /flex:\s*1/, "input takes the free space");
  assert.match(input, /min-width:\s*0/, "input shrinks below its intrinsic ~20ch width so the Copy button stays reachable");
});

test("the auth panel itself is viewport-relative at phone widths", () => {
  const panel = declarationsFor(sheets, "#auth-panel.auth-panel");
  assert.ok(panel.trim(), "#auth-panel.auth-panel has a rule");
  assert.match(panel, /width:\s*min\(100%/, "panel width tracks the viewport, never a fixed pixel width");
});

test("welcome choices stack instead of sitting side by side", () => {
  const welcome = declarationsFor(sheets, ".signin-welcome");
  assert.ok(welcome.trim(), ".signin-welcome has a rule");
  assert.match(welcome, /display:\s*grid/, "Create account / Log in stack vertically at 360px");
});

test("Google and primary sign-in buttons span the panel", () => {
  const buttons = declarationsFor(sheets, ".signin-methods .button");
  assert.ok(buttons.trim(), ".signin-methods .button has a rule");
  assert.match(buttons, /width:\s*100%/, "method buttons fill the panel width");
  assert.doesNotMatch(buttons, /white-space:\s*nowrap/, "button labels may wrap, never clip");
  const google = declarationsFor(sheets, "#auth-panel #google-signin");
  assert.doesNotMatch(google, /white-space:\s*nowrap/, "Continue with Google never clips");
});

test("sign-in inputs stay at 16px so iOS does not auto-zoom", () => {
  const input = declarationsFor(sheets, "#auth-panel input");
  assert.match(input, /font-size:\s*var\(--text-md\)/, "sign-in inputs use --text-md");
  const root = declarationsFor(sheets, ":root");
  assert.match(root, /--text-md:\s*1rem/, "--text-md is 1rem (16px): below that iOS Safari zooms on focus");
});

test("the already-fixed join-page secret row stays fixed", () => {
  const input = declarationsFor([sheets[2]], ".join-secret-row input");
  assert.match(input, /min-width:\s*0/, "join-page access-key row keeps its narrow-viewport guard");
});

test("agent created view actually renders the guarded rows", () => {
  const js = readFileSync(new URL("../src/agent-signin-ui.js", import.meta.url), "utf8");
  assert.match(js, /class="agent-secret-row"/, "created view renders .agent-secret-row");
  assert.match(js, /data-agent-copy/, "each secret row offers a Copy button");
});

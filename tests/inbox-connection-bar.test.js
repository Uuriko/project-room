// Inbox connection-state surface: the room's SSE stream stays alive behind the
// inbox (inbox-ui.js show() never disconnects it), so a dropped stream while the
// inbox is open must keep its banner visible, its live-region announcement, and
// its manual refresh control. Fail-first: the pre-fix stylesheet hides the whole
// .connection-bar (and #refresh-button) with display:none whenever the inbox is
// open, which also removes the role="status" live region from the accessibility
// tree, silently swallowing the "Connection interrupted" announcement.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const cssPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "styles.css");
const css = readFileSync(cssPath, "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

// Split the stylesheet into { selectors, body } rules (top-level only is enough:
// the inbox rules live at the top level).
function rules() {
  const out = [];
  for (const chunk of css.split("}")) {
    const brace = chunk.indexOf("{");
    if (brace === -1) continue;
    out.push({ selectors: chunk.slice(0, brace).trim(), body: chunk.slice(brace + 1).trim() });
  }
  return out;
}

const inboxBarRules = () =>
  rules().filter(r => r.selectors.includes("#inbox-panel") && r.selectors.includes(".connection-bar"));

test("inbox-open never display:none's the connection bar while it reports an interrupted state", () => {
  const hiding = inboxBarRules().filter(r => /display\s*:\s*none/.test(r.body));
  for (const rule of hiding) {
    assert.ok(
      rule.selectors.includes('[data-state="other"]'),
      `inbox rule hides .connection-bar without a data-state="other" exception:\n${rule.selectors} { ${rule.body} }`
    );
  }
});

test("inbox-open keeps the connection bar in the accessibility tree when healthy", () => {
  // display:none removes the role="status" live region from the a11y tree, so a
  // stream drop that lands while the inbox is open is never announced. The bar
  // may be visually hidden, but only with the same sr-only clip the connected
  // state already uses (see the [data-state="connected"] rule).
  for (const rule of inboxBarRules()) {
    if (/display\s*:\s*none/.test(rule.body)) {
      assert.ok(
        rule.selectors.includes('[data-state="other"]'),
        `inbox rule removes .connection-bar from the a11y tree unconditionally:\n${rule.selectors}`
      );
    }
  }
});

test("inbox-open does not hide the manual refresh control while the connection is interrupted", () => {
  const hiding = rules().filter(r =>
    r.selectors.includes("#inbox-panel") &&
    r.selectors.includes("#refresh-button") &&
    /display\s*:\s*none/.test(r.body)
  );
  for (const rule of hiding) {
    assert.ok(
      rule.selectors.includes('[data-state="other"]'),
      `inbox rule hides #refresh-button with no interrupted-state exception:\n${rule.selectors} { ${rule.body} }`
    );
  }
});

test("interrupted-state refresh control keeps a 44px touch target at phone widths with the inbox open", () => {
  const hit = rules().some(r =>
    r.selectors.includes("#refresh-button") &&
    r.selectors.includes('[data-state="other"]') &&
    r.selectors.includes("#inbox-panel") &&
    /min-height\s*:\s*44px/.test(r.body)
  );
  assert.ok(hit, "no ≤520px rule gives the inbox-interrupted #refresh-button a 44px touch target");
});

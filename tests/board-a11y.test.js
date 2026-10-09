// BU-11 (PRODUCT-200 client craft): board-UI accessibility guards.
//
// The board surface renders text/background pairs built from the canonical
// design tokens in src/design-tokens.js (src/styles.css documents dark as the
// product default, light opt-in via [data-theme="light"]). This file computes
// real WCAG 2.1 contrast ratios for every text/background pair on the board
// surface, in both themes, and fails if any pair drops below the AA bar:
//   - 4.5:1 for text (WCAG 1.4.3)
//   - 3:1 for the focus indicator (WCAG 1.4.11, UI components)
// plus static naming checks for the board dialog and its buttons (WCAG 4.1.2).
//
// Why this is its own test (test-audit gate): no existing test measures a
// single contrast ratio — qa5r-board-nav-style.test.js asserts CSS shape, not
// ratios — and token edits have regressed contrast silently before (D-fo-5
// was withdrawn at 1.0:1 on dark panels). It reads the existing DARK/LIGHT
// exports and index.html from disk; no production seam, no mocks, no stubbed
// boundary.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DARK, LIGHT } from "../src/design-tokens.js";

const srgb = channel => {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

const luminance = hex => {
  const [r, g, b] = [0, 2, 4].map(i => parseInt(hex.slice(i + 1, i + 3), 16));
  return 0.2126 * srgb(r) + 0.7152 * srgb(g) + 0.0722 * srgb(b);
};

const ratio = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

const fmt = n => n.toFixed(2);

// Every pair is (label, foreground token, background token) as actually used
// on the board surface. Measured 2026-10-08; all pass AA today — the test
// exists so a token edit can never ship a silent regression.
const BOARD_TEXT_PAIRS = [
  // #tasks-board-open: sidebar nav row, transparent over app bg
  ["sidebar Board entry", "--text", "--bg"],
  // [data-claim-cap] button (owner Save cap)
  ["claim-cap button", "--text", "--panel-raised"],
  // .live-chip: transparent chip over app bg
  ["live chip", "--text", "--bg"],
  // .board-columns section h3 on section background
  ["column heading", "--text", "--panel-raised"],
  // .claim-card h4 on card background
  ["claim title", "--text", "--card"],
  // .claim-owner / .claim-lease / .claim-pr body copy on card
  ["claim body copy", "--text", "--card"],
  // .ci-badge states on claim card
  ["CI badge (success)", "--green", "--card"],
  ["CI badge (failure)", "--red", "--card"],
  ["CI badge (pending/neutral)", "--muted", "--card"],
  // .claim-update timeline lines on claim card
  ["claim update line", "--muted", "--card"],
  // .claim-waiting / .form-hint / .board-older secondary copy
  ["secondary hint on card", "--muted", "--card"],
  ["secondary hint on raised panel", "--muted", "--panel-raised"],
  // .board-empty / board wrapper copy over app bg
  ["empty-board copy", "--text", "--bg"],
  // work links (claim titles link to work records)
  ["link on app bg", "--blue", "--bg"],
  ["link on card", "--blue", "--card"],
  // .button tones used by claim actions (Claim/Done = primary,
  // Renew/Release/Link PR/Move/Add item = secondary)
  ["button primary label", "--on-accent", "--blue-strong"],
  ["button secondary label", "--text", "--panel-raised"],
  // .button.ghost (dialog Close): muted text, transparent over app bg
  ["button ghost label", "--muted", "--bg"],
];

for (const [themeName, tokens] of [["dark", DARK], ["light", LIGHT]]) {
  for (const [label, fgToken, bgToken] of BOARD_TEXT_PAIRS) {
    test(`board text contrast (${themeName}): ${label}`, () => {
      const r = ratio(tokens[fgToken], tokens[bgToken]);
      assert.ok(
        r >= 4.5,
        `${label}: ${tokens[fgToken]} on ${tokens[bgToken]} = ${fmt(r)}:1, below WCAG AA 4.5:1 (${themeName} theme)`
      );
    });
  }

  test(`board focus indicator contrast (${themeName})`, () => {
    // styles.css: select/input/textarea/button:focus-visible and
    // a/summary:focus-visible draw a 2px --blue outline — a 1.4.11 UI
    // component indicator that must reach 3:1 against the surface it sits on.
    const r = ratio(tokens["--blue"], tokens["--bg"]);
    assert.ok(r >= 3, `focus outline ${tokens["--blue"]} on ${tokens["--bg"]} = ${fmt(r)}:1, below 3:1 (${themeName})`);
  });
}

const indexHtml = readFileSync(new URL("../index.html", import.meta.url), "utf8");

const buttonTag = id => {
  const match = indexHtml.match(new RegExp(`<button\\b[^>]*\\bid="${id}"[^>]*>`));
  assert.ok(match, `#${id} exists in index.html`);
  return match[0];
};

const accessibleName = id => {
  const tag = buttonTag(id);
  const aria = /aria-label="([^"]*)"/.exec(tag)?.[1];
  if (aria) return aria;
  const inner = indexHtml.slice(indexHtml.indexOf(tag) + tag.length).split("</button>")[0];
  return inner.replace(/<[^>]+>/g, "").replace(/&[^;]+;/g, " ").trim();
};

test("board dialog is a labelled modal (4.1.2)", () => {
  const dialog = indexHtml.match(/<dialog\b[^>]*\bid="board-dialog"[^>]*>/);
  assert.ok(dialog, "#board-dialog exists");
  const labelledby = /aria-labelledby="([^"]+)"/.exec(dialog[0])?.[1];
  assert.ok(labelledby, "#board-dialog names its label");
  const heading = new RegExp(`<h2\\b[^>]*\\bid="${labelledby}"[^>]*>([\\s\\S]*?)</h2>`).exec(indexHtml);
  assert.ok(heading && heading[1].trim().length > 0, `#${labelledby} has non-empty text`);
});

test("board open/close controls have accessible names", () => {
  assert.ok(accessibleName("tasks-board-open").length > 0, "#tasks-board-open is named");
  assert.ok(accessibleName("board-close").length > 0, "#board-close is named");
});

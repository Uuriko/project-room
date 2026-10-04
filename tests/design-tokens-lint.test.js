// D-fo-6 step 1: pins the design-token ratchet's detection contract.
// Without these, a regex regression in scripts/lint-design-tokens.mjs
// would make CI pass vacuously.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  hexHits,
  rawFontSizeValue,
  rawFontShorthandValue,
  scanTree,
  loadBaseline,
  diffAgainstBaseline,
} from "../scripts/lint-design-tokens.mjs";

test("hexHits flags hex colors in declaration values", () => {
  assert.deepEqual(hexHits("  color: #fff;"), ["#fff"]);
  assert.deepEqual(hexHits("  border: 1px solid #a3b2c1;"), ["#a3b2c1"]);
  assert.deepEqual(hexHits("  background: linear-gradient(#ffffff, #000000);"), [
    "#ffffff",
    "#000000",
  ]);
  assert.deepEqual(hexHits("  box-shadow: 0 2px 4px #00000080;"), ["#00000080"]);
});

test("hexHits ignores ID selectors and token definitions", () => {
  assert.deepEqual(hexHits("#action-dialog {"), []);
  assert.deepEqual(hexHits(".foo { --brand: #123456; }"), []);
  assert.deepEqual(hexHits("  --op-fg: #1b1b1f;"), []);
});

test("hexHits still flags raw hexes beside token definitions and var fallbacks", () => {
  assert.deepEqual(hexHits(".foo { --brand: #123456; color: #000; }"), ["#000"]);
  assert.deepEqual(hexHits("  color: var(--brand, #123456);"), ["#123456"]);
});

test("rawFontSizeValue flags literal sizes, allows the token path", () => {
  assert.equal(rawFontSizeValue("  font-size: 16px;"), "16px");
  assert.equal(rawFontSizeValue(".x { font-size: .875rem; }"), ".875rem");
  assert.equal(rawFontSizeValue("  font-size:1rem"), "1rem");
  assert.equal(rawFontSizeValue("  font-size: var(--text-sm);"), null);
  assert.equal(rawFontSizeValue("  font-size: var(--text-sm, 14px);"), null);
});

test("hexHits flags =-prefixed hexes in data URIs", () => {
  assert.deepEqual(
    hexHits('  background: url("data:image/svg+xml,<svg fill=#ff0000></svg>");'),
    ["#ff0000"]
  );
});

test("rawFontSizeValue is case-insensitive (CSS property names are)", () => {
  assert.equal(rawFontSizeValue("  FONT-SIZE: 16px;"), "16px");
  assert.equal(rawFontSizeValue(".x { Font-Size: .875rem; }"), ".875rem");
});
test("rawFontSizeValue ignores custom properties and lookalikes", () => {
  assert.equal(rawFontSizeValue("  --font-size: 16px;"), null);
  assert.equal(rawFontSizeValue("  font-size-adjust: .5;"), null);
  assert.equal(rawFontSizeValue("  line-height: 1.5;"), null);
});

test("rawFontShorthandValue flags raw sizes in the font: shorthand", () => {
  assert.equal(rawFontShorthandValue("  font: 16px/1.5 sans-serif;"), "16px");
  assert.equal(
    rawFontShorthandValue("  font: italic bold .875rem/1.4 system-ui;"),
    ".875rem"
  );
  assert.equal(rawFontShorthandValue("  FONT: 12pt serif;"), "12pt");
  assert.equal(rawFontShorthandValue("  font: small serif;"), "small");
});

test("rawFontShorthandValue allows inherit, system fonts, and tokens", () => {
  assert.equal(rawFontShorthandValue("  font: inherit;"), null);
  assert.equal(rawFontShorthandValue("  font: var(--font-sans);"), null);
  assert.equal(rawFontShorthandValue("  font: caption;"), null);
  assert.equal(rawFontShorthandValue("  font: small-caps serif;"), null);
  assert.equal(rawFontShorthandValue("  font-size: 16px;"), null);
  assert.equal(rawFontShorthandValue("  font-family: serif;"), null);
});

test("diffAgainstBaseline reports new violations and stale entries", () => {
  const baseline = new Map([["a.css ::: color: #fff; // x1", 1]]);
  const current = new Map([
    ["a.css ::: color: #fff; // x1", 1],
    ["b.css ::: font-size: 99px; // x1", 1],
  ]);
  const { added, removed } = diffAgainstBaseline(current, baseline);
  assert.equal(added.length, 1);
  assert.match(added[0], /b\.css/);
  assert.deepEqual(removed, []);

  const { removed: removed2 } = diffAgainstBaseline(
    new Map(),
    new Map([["gone.css ::: color: #abc; // x1", 1]])
  );
  assert.equal(removed2.length, 1);
});

test("current tree has no new violations against the baseline", () => {
  const { added, removed } = diffAgainstBaseline(scanTree(), loadBaseline());
  assert.deepEqual(added, []);
  assert.deepEqual(removed, []);
});

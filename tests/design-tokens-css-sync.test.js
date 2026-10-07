// The app stylesheet's theme variable blocks are generated from
// src/design-tokens.js (single source of truth). scripts/sync-design-tokens-css.mjs
// owns the regeneration (`--check` runs in scripts/check.mjs); this test pins
// the contract at the stylesheet boundary: the marked blocks exist, they parse
// to exactly the canonical token maps, and the file is in sync. A token edit
// without regeneration — or a hand-edit inside a marked block — fails here.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { DARK, LIGHT } from "../src/design-tokens.js";
import { syncTokensCss, hasTokenMarkers } from "../scripts/sync-design-tokens-css.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(root, "src", "styles.css"), "utf8");

function blockVars(marker) {
  const begin = `/* tokens:begin ${marker} */`;
  const end = `/* tokens:end ${marker} */`;
  const b = css.indexOf(begin);
  const e = css.indexOf(end, b);
  assert.ok(b !== -1 && e !== -1, `styles.css carries the generated ${marker} token block`);
  const vars = {};
  for (const part of css.slice(b + begin.length, e).split(";")) {
    const pair = part.trim();
    if (!pair) continue;
    const i = pair.indexOf(":");
    vars[pair.slice(0, i)] = pair.slice(i + 1);
  }
  return vars;
}

test("styles.css carries generated token blocks for both themes", () => {
  assert.ok(hasTokenMarkers(css), "token markers present (DARK and LIGHT)");
});

test("generated blocks equal the canonical token maps", () => {
  assert.deepEqual(blockVars("DARK"), { ...DARK });
  assert.deepEqual(blockVars("LIGHT"), { ...LIGHT });
});

test("styles.css is in sync with src/design-tokens.js", () => {
  assert.equal(
    syncTokensCss(css),
    css,
    "token blocks drifted from src/design-tokens.js — run: node scripts/sync-design-tokens-css.mjs",
  );
});

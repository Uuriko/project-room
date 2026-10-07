// Regenerate the design-token variable blocks in src/styles.css from
// src/design-tokens.js (single source of truth).
//
// The :root (dark) and [data-theme="light"] blocks carry marker comments;
// everything between a begin/end marker pair is replaced with the generated
// declarations, preserving the surrounding lines (color-scheme, aliases).
// Values stay byte-identical when tokens are unchanged, so regeneration is a
// no-op diff unless a token actually moved.
//
// Run:   node scripts/sync-design-tokens-css.mjs
// Check: node scripts/sync-design-tokens-css.mjs --check   (CI gate)
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { DARK_DECLARATIONS, LIGHT_DECLARATIONS } from "../src/design-tokens.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CSS_PATH = join(root, "src", "styles.css");

const BLOCKS = [
  { marker: "DARK", declarations: DARK_DECLARATIONS },
  { marker: "LIGHT", declarations: LIGHT_DECLARATIONS },
];

export function hasTokenMarkers(cssText) {
  return BLOCKS.every(
    ({ marker }) =>
      cssText.includes(`/* tokens:begin ${marker} */`) && cssText.includes(`/* tokens:end ${marker} */`),
  );
}

export function syncTokensCss(cssText) {
  let out = cssText;
  for (const { marker, declarations } of BLOCKS) {
    const begin = `/* tokens:begin ${marker} */`;
    const end = `/* tokens:end ${marker} */`;
    const b = out.indexOf(begin);
    const e = out.indexOf(end, b);
    if (b === -1 || e === -1) continue;
    const lineStart = out.lastIndexOf("\n", b) + 1;
    const lineEnd = out.indexOf("\n", e + end.length);
    const indent = out.slice(lineStart, b).match(/^[ \t]*/)[0];
    out =
      out.slice(0, lineStart) +
      `${indent}${begin}\n${indent}${declarations};\n${indent}${end}` +
      out.slice(lineEnd);
  }
  return out;
}

const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) {
  const check = process.argv.includes("--check");
  const before = readFileSync(CSS_PATH, "utf8");
  if (!hasTokenMarkers(before)) {
    console.error("sync-design-tokens-css: token markers missing from src/styles.css");
    process.exit(1);
  }
  const after = syncTokensCss(before);
  if (after !== before) {
    if (check) {
      console.error(
        "sync-design-tokens-css: styles.css token blocks are out of sync with src/design-tokens.js — run: node scripts/sync-design-tokens-css.mjs",
      );
      process.exit(1);
    }
    writeFileSync(CSS_PATH, after);
    console.log("sync-design-tokens-css: regenerated token blocks in src/styles.css");
  } else {
    console.log("sync-design-tokens-css: styles.css already in sync");
  }
}

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
    const nl = out.indexOf("\n", e + end.length);
    // An end marker as the file's last line (no trailing newline) is not a
    // missing newline: splice to EOF instead of slice(-1), which would
    // duplicate the final character.
    const lineEnd = nl === -1 ? out.length : nl;
    const indent = out.slice(lineStart, b).match(/^[ \t]*/)[0];
    out =
      out.slice(0, lineStart) +
      `${indent}${begin}\n${indent}${declarations};\n${indent}${end}` +
      out.slice(lineEnd);
  }
  return out;
}

function usage() {
  return [
    "usage: node scripts/sync-design-tokens-css.mjs [--check] [--help]",
    "",
    "Regenerate the design-token variable blocks in src/styles.css from",
    "src/design-tokens.js (single source of truth).",
    "  --check   read-only: exit 1 when the token blocks are out of sync (CI gate)",
    "  --help    print this usage and exit 0",
    "With no flags the token blocks are rewritten in src/styles.css.",
  ].join("\n");
}

function main(argv) {
  let check = false;
  for (const a of argv) {
    if (a === "--check") check = true;
    else if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    } else {
      // Fail closed: an unknown flag (e.g. a typo'd --check) must never
      // silently run in write mode and rewrite src/styles.css.
      console.error(usage());
      console.error(`\nsync-design-tokens-css: unknown argument: ${a}`);
      process.exit(2);
    }
  }
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

const isMainModule =
  !!process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMainModule) main(process.argv.slice(2));

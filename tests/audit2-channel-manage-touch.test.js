// Audit wave 2 lane 2 (client UI/UX): the owner-only channel-settings
// button (.channel-manage, "⋯") is opacity:0 until row hover/focus-within.
// Touch viewports have no hover, so channel management is undiscoverable on
// phones. Contract: the stylesheet must include a coarse-pointer/touch
// fallback that keeps .channel-manage visible, mirroring the pattern the
// codebase already uses for touch (e.g. the reaction sheet bottom-sheet
// rule under `@media (hover: none), (pointer: coarse)`).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const css = readFileSync(join(ROOT, "src", "styles.css"), "utf8");

test("channel-manage stays hidden-by-default on hover-capable pointers", () => {
  assert.match(
    css,
    /\.channel-manage\s*\{\s*opacity:\s*0/,
    ".channel-manage should remain opacity:0 by default (hover reveals it on desktop)",
  );
});

test("channel-manage is revealed for touch/coarse pointers", () => {
  // Find every @media block mentioning coarse pointers or no-hover, and
  // require one of them to set .channel-manage opacity to 1.
  const blocks = [...css.matchAll(/@media[^{]*\{/g)];
  let revealed = false;
  for (const b of blocks) {
    const header = b[0];
    if (!/(pointer:\s*coarse|hover:\s*none)/.test(header)) continue;
    // Walk balanced braces from the block start to get its full body.
    let depth = 0, end = b.index;
    for (let i = b.index; i < css.length; i++) {
      if (css[i] === "{") depth++;
      else if (css[i] === "}") { depth--; if (depth === 0) { end = i; break; } }
    }
    const body = css.slice(b.index, end);
    if (/\.channel-manage\s*\{[^}]*opacity\s*:\s*1/.test(body)) { revealed = true; break; }
  }
  assert.ok(
    revealed,
    "expected a @media (hover: none) / (pointer: coarse) block that sets .channel-manage { opacity: 1 }",
  );
});

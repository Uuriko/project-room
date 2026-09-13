// Muse-lane / tip #11: Done-chip spring is CSS-only, composite-safe, and instant
// under prefers-reduced-motion. No presence/status derivation changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const css = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "../src/styles.css"), "utf8");

function blockAfter(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  let i = source.indexOf("{", start);
  assert.ok(i >= 0, `missing body for ${marker}`);
  let depth = 0;
  for (; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}") {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  assert.fail(`unclosed body for ${marker}`);
}

test("Done-chip spring uses transform/opacity only and is instant under reduced motion", () => {
  const keyframes = blockAfter(css, "@keyframes done-chip-pop");
  const decls = keyframes.replace(/@keyframes done-chip-pop/, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const props = [...decls.matchAll(/(?:^|[;{])\s*([a-z-]+)\s*:/gi)].map(match => match[1].toLowerCase());
  assert.ok(props.includes("opacity") && props.includes("transform"), "keyframes animate opacity and transform");
  for (const prop of props) {
    assert.ok(prop === "opacity" || prop === "transform", `composite-only keyframes; unexpected ${prop}`);
  }
  assert.doesNotMatch(keyframes, /gradient|confetti|filter|box-shadow|left|top|margin|width|height|background/i);

  const motion = blockAfter(css, "@media (prefers-reduced-motion: no-preference)");
  assert.match(motion, /\.done-chip\s*\{[^}]*animation:\s*done-chip-pop/);
  assert.doesNotMatch(css.replace(motion, ""), /\.done-chip\s*\{[^}]*animation:\s*done-chip-pop/);

  const reduce = blockAfter(css, "@media (prefers-reduced-motion: reduce)");
  assert.match(reduce, /\.done-chip\s*\{[^}]*animation:\s*none\s*!important/);
  assert.match(reduce, /\.done-chip\s*\{[^}]*opacity:\s*1/);
  assert.match(reduce, /\.done-chip\s*\{[^}]*transform:\s*none/);
});

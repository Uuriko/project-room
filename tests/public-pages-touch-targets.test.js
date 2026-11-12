// Design pass 2026-11-12: public pages must give touch users 44px link
// targets and keep the top bar aligned with the page column. Source-level pin
// so a later style edit cannot drop either back.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("public rooms pages floor header/footer links at 44px on coarse pointers", () => {
  const css = read("../server/public-rooms.mjs");
  assert.match(css, /@media \(pointer:coarse\)\{[^}]*header a[^}]*footer a[^}]*min-height:2\.75rem/);
});

test("public rooms top bar shares the page column", () => {
  const css = read("../server/public-rooms.mjs");
  assert.match(css, /body>header\{max-width:42rem;margin:0 auto;padding:1rem 1\.25rem 0\}/);
});

test("public face (/watch) floors page-actions and footer links on coarse pointers", () => {
  const css = read("../server/public-face.mjs");
  assert.match(css, /@media \(pointer:coarse\)\{[^}]*\.page-actions a:not\(\.connect-agent\)[^}]*footer a[^}]*min-height:var\(--control-min-target-coarse\)/);
});

test("sign-in card hint links reach the coarse touch floor", () => {
  const css = read("../src/public-a11y.css");
  assert.match(css, /@media \(pointer: coarse\) \{\s*\.join-card \.form-hint a \{[^}]*min-height: var\(--control-min-target-coarse\)/);
});

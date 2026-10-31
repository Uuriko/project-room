// MI-020 / MI-033 (Jill master-issues): /join loading state is announced and
// the "Log in" link is at least a 44x44 px tap target.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("join loading card is a polite live region", () => {
  const html = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  assert.match(html, /<div id="join-loading" class="join-card" role="status" aria-live="polite">/);
});

test("join Log in link has a 44px minimum tap target", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  const rule = css.match(/#join-enter-home \{([^}]*)\}/)?.[1] ?? "";
  assert.match(rule, /min-width: 44px/);
  assert.match(rule, /min-height: 44px/);
});

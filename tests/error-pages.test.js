// Error pages: honest copy, a useful next step, and dark-default rendering.
// Fail-first for wave500/g7/c16 — the styles/copy below did not exist when written.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const notFound = readFileSync(new URL("../404.html", import.meta.url), "utf8");
const offline = readFileSync(new URL("../offline.html", import.meta.url), "utf8");

test("404.html renders dark-first, never a white flash", () => {
  assert.match(notFound, /<style>/, "404.html needs inline styles (dark default, no unstyled flash)");
  assert.match(notFound, /color-scheme:\s*dark/, "404.html must declare dark color-scheme");
  assert.match(notFound, /#202127/, "404.html must use the canonical dark page background");
  assert.match(notFound, /#eeedf1/, "404.html must use the canonical dark body text");
});

test("404.html stays honest about the missing page", () => {
  assert.match(notFound, /<title>Page not found<\/title>/);
  assert.match(notFound, /<h1>Page not found<\/h1>/);
  assert.match(notFound, /This address is not a page on Project Room\./);
});

test("404.html offers a useful next step home", () => {
  assert.match(notFound, /<a href="\/">Home<\/a>/);
});

test("offline.html offers a retry action", () => {
  assert.match(offline, /Try again/i, "offline.html needs a retry action");
  assert.match(offline, /location\.reload\(\)/, "retry must reload the page");
});

test("offline.html says what still works offline", () => {
  assert.match(offline, /You're offline/, "must state plainly that the user is offline");
  assert.match(offline, /only this page/i, "must be honest: only this page is available offline");
});

test("offline.html uses the canonical design tokens", () => {
  assert.match(offline, /color-scheme:\s*dark/, "offline.html must declare dark color-scheme");
  assert.match(offline, /#a9b9ff/, "links must use the canonical dark link token");
  assert.ok(!offline.includes("#c7c7ff"), "off-token link color #c7c7ff is gone");
});

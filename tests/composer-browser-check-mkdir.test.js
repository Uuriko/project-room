// Regression: scripts/composer-browser-check.mjs writes screenshots under
// test-results/ but never created the directory. In a checkout where
// test-results/ does not exist yet (gitignored), the first page.screenshot
// throws ENOENT and the whole browser check fails. Every sibling browser
// check creates it with mkdirSync("test-results", { recursive: true }).
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = readFileSync(
  fileURLToPath(new URL("../scripts/composer-browser-check.mjs", import.meta.url)),
  "utf8"
);

test("composer browser check creates test-results before screenshotting", () => {
  const screenshotRefs = [...source.matchAll(/screenshot\(\{\s*path:\s*[`'"]test-results\//g)];
  assert.ok(screenshotRefs.length > 0, "the check writes screenshots under test-results/");
  const mkdirIndex = source.search(/mkdirSync\(\s*["']test-results["']\s*,\s*\{\s*recursive:\s*true\s*\}\s*\)/);
  assert.ok(mkdirIndex !== -1, "the check creates test-results/ with a recursive mkdirSync");
  const firstScreenshot = source.search(/screenshot\(\{\s*path:\s*[`'"]test-results\//);
  assert.ok(mkdirIndex < firstScreenshot,
    "the directory is created before the first screenshot is taken");
});

test("the fs import carries mkdirSync", () => {
  assert.match(source, /import\s*\{\s*[^}]*\bmkdirSync\b[^}]*\}\s*from\s*["']node:fs["']/);
});

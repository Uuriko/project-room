import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const desc = /<meta name="description" content="[^"]{50,160}">/;

test("/join has a meta description and keeps noindex", () => {
  const html = readFileSync(new URL("../join.html", import.meta.url), "utf8");
  assert.match(html, desc);
  assert.match(html, /<meta name="robots" content="noindex, nofollow">/);
});

test("/download has a meta description", () => {
  const src = readFileSync(new URL("../server/download-page.mjs", import.meta.url), "utf8");
  assert.match(src, desc);
});

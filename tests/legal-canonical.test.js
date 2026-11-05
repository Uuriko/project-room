// Legal pages carry an HTML canonical matching their Link header; /terms unchanged.
import test from "node:test";
import assert from "node:assert/strict";
import { legalPageHtml } from "../server/legal-pages.mjs";

test("privacy, subprocessors, acceptable-use and legal carry an absolute canonical link", () => {
  for (const path of ["/privacy", "/subprocessors", "/acceptable-use", "/legal"]) {
    const html = legalPageHtml(path);
    const links = html.match(/<link rel="canonical" href="([^"]+)">/g) ?? [];
    assert.equal(links.length, 1, `${path} has exactly one canonical`);
    assert.ok(links[0].includes(`href="https://room.trydemigod.com${path}"`), `${path} canonical points at itself`);
  }
});

test("terms page is left without an HTML canonical", () => {
  assert.doesNotMatch(legalPageHtml("/terms"), /rel="canonical"/);
});

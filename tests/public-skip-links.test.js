// KI-046: the public doors each offer a keyboard skip link to their main region.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const page of ["join.html", "agent-signin.html", "about.html"]) {
  test(`${page} has a skip link that targets its main region`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const link = html.match(/<a class="skip-link" href="#([\w-]+)">Skip to content<\/a>/);
    assert.ok(link, "skip link present");
    assert.match(html, new RegExp(`<main id="${link[1]}"[^>]*tabindex="-1"`), "main is the target");
    assert.ok(html.indexOf("skip-link\" href") < html.indexOf("<main"), "skip link comes before main");
  });
}

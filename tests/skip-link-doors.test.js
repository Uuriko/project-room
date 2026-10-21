// Grok Build 17185: the skip link existed only on /. The two stranger doors
// that render outside the app shell carry their own keyboard skip link.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

for (const page of ["join.html", "agent-signin.html"]) {
  test(`${page} offers a skip link to its main region`, () => {
    const html = readFileSync(new URL(`../${page}`, import.meta.url), "utf8");
    const link = html.indexOf('<a class="skip-link" href="#page-main">');
    assert.ok(link > html.indexOf("<body>"), "skip link is inside body");
    assert.ok(link < html.indexOf("<main"), "skip link is the first stop before main");
    assert.match(html, /<main[^>]*id="page-main"[^>]*tabindex="-1"/);
    assert.match(html, /src\/styles\.css/, "the .skip-link rule ships with this page");
  });
}

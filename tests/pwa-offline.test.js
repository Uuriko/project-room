// Offline page recovery contract (PRODUCT-200 M-06). /offline.html is served
// under the site's full Content-Security-Policy (script-src 'self'), so an
// inline recovery script would be silently blocked; the page must offer a
// same-origin way back that works with no JavaScript at all.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../offline.html", import.meta.url), "utf8");

test("the offline page tells the human what happened and offers a no-JS way back", () => {
  assert.match(html, /Room is offline/);
  assert.match(html, /<a[^>]+href="\/"[^>]*>/, "a same-origin retry link");
});

test("the offline page carries no inline script the CSP would block", () => {
  assert.doesNotMatch(html, /<script[\s>]/);
});

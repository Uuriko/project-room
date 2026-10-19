// F2/F6: the discovery surfaces must not be dead ends. The landing's
// served bytes are the contract for strangers and crawlers (the server
// serves index.html verbatim): the sign-in wall's entry routes link the
// two public surfaces, and the footer links the receipts gallery. The
// footer used to name one specific receipt as its exemplar; that
// receipt was unreviewed, so PROOF-WALL-FLIP removed the naming — the
// gallery link stays, no single unverified receipt is featured. The
// /offers page's empty state is the exact string its client
// renders, so it is pinned at the source: an empty board points at the
// gallery ("see work already done") instead of ending at "check back".
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

test("the landing links open work and the receipts gallery from the sign-in wall (F2)", () => {
  const html = read("../index.html");
  const routes = html.slice(html.indexOf('id="signin-entry-routes"'), html.indexOf("</section>", html.indexOf('id="signin-entry-routes"')));
  assert.match(routes, /<a class="text-button" href="\/offers">Open work<\/a>/);
  assert.match(routes, /<a class="text-button" href="\/receipts">Receipts<\/a>/);
});

test("the landing footer links the gallery and names no single receipt (F2, PROOF-WALL-FLIP)", () => {
  const html = read("../index.html");
  const footer = html.slice(html.indexOf('<footer class="site-footer">'));
  assert.match(footer, /href="\/receipts">Browse published receipts</,
    "the footer links the public receipts gallery");
  assert.ok(!/pwr_[a-f0-9]{64}/.test(footer),
    "no specific receipt is named as an exemplar — the previous one was unreviewed");
  assert.ok(!footer.includes("Docs link sweep"), "the unreviewed sample's title is gone");
});

test("the offers empty state points at the gallery (F6)", () => {
  const ui = read("../src/project-offers-ui.js");
  assert.match(ui, /No open tasks right now — <a href="\/receipts">see work already done<\/a>/,
    "empty board renders the honest empty state with a gallery link");
  assert.doesNotMatch(ui, /No open offers yet\. Check back soon\./,
    "the dead-end copy is gone");
});

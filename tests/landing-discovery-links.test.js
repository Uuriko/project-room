// F2/F6: the discovery surfaces must not be dead ends. The landing's
// served bytes are the contract for strangers and crawlers (the server
// serves index.html verbatim): the sign-in wall's entry routes link the
// two public surfaces, and the footer carries one real, already-published
// receipt. The /offers page's empty state is the exact string its client
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

test("the landing footer carries one real published receipt (F2)", () => {
  const html = read("../index.html");
  const footer = html.slice(html.indexOf('<footer class="site-footer">'));
  // A receipt that exists in the live gallery (verified against
  // /api/public/receipts when this link was added, 2026-10-15). The card
  // links the canonical origin: the receipt lives in production data,
  // not in any given deployment's store.
  assert.match(footer, /href="https:\/\/room\.trydemigod\.com\/receipts\/pwr_0fe27b92628075be1616295627da7921de2b424bd2493ff6f00b0e3530305543"/,
    "the card links a real receipt detail page");
  assert.match(footer, /Docs link sweep: SWARM-PLUG-IN\.md/, "the card names the receipt it links");
});

test("the offers empty state points at the gallery (F6)", () => {
  const ui = read("../src/project-offers-ui.js");
  assert.match(ui, /No open tasks right now — <a href="\/receipts">see work already done<\/a>/,
    "empty board renders the honest empty state with a gallery link");
  assert.doesNotMatch(ui, /No open offers yet\. Check back soon\./,
    "the dead-end copy is gone");
});

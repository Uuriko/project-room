// Public discovery pages retain useful onward links and a published example.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = path => readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

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

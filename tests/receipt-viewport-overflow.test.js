// tests/receipt-viewport-overflow.test.js — 360px viewport overflow guards for
// receipt cards and the public receipt detail page.
//
// Two real overflow gaps, found by reading the renderers (WAVE-500 G8 14/50):
//
//   1. In-app receipt card (src/app.js receiptCard -> div.receipt): the card
//      renders reporter-supplied summary / nextAction / verification text in
//      bare <p> elements. src/styles.css gave .receipt-attribution dd and
//      .receipt code overflow-wrap, but .receipt p had none. overflow-wrap is
//      not inherited, so a long unbroken token (hash, URL, file path) in the
//      summary overflows the card at 360px.
//   2. Public receipt detail page (server/receipts-page.mjs): the inline style
//      wraps .card and .detail (hashes, PR URLs) but not the page <h1>, which
//      renders the room-supplied receipt title. A long unbroken title
//      overflows the viewport at 360px. (The /receipts list h2 titles sit
//      inside article.card, already wrapped.)
//
// Behavior protected: the wrapping declarations above must survive. A later
// edit that drops overflow-wrap from .receipt p or from the detail-page h1
// rule fails the assertions below.
//
// Production seam: the real renderers (renderReceiptDetailHtml /
// renderReceiptsHtml), the real inline <style>, the real src/styles.css.
// No mocks, no browser. What this cannot prove (honest limit): true pixel
// layout needs a real engine at 360px — these guards pin the declarations
// that make wrapping possible, which is the mechanism under test.
//
// Run: TMPDIR=$PWD/.tmp node --test tests/receipt-viewport-overflow.test.js
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { renderReceiptDetailHtml, renderReceiptsHtml } from "../server/receipts-page.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");

const LONG_TOKEN = "sha256:" + "ab".repeat(100); // 207-char unbroken token
const LONG_URL = "https://github.com/Uuriko/project-room/pull/" + "9".repeat(120);

const hostileReceipt = {
  schema: "project-room-public-receipt/1",
  id: "wcr_overflow_probe",
  title: LONG_TOKEN,
  source: "work-claim",
  room: { id: "commons", title: "Commons" },
  agents: ["agent-alice"],
  humans: ["Bob"],
  pullRequest: LONG_URL,
  mergedAt: "2026-10-07T18:00:00.000Z",
  hashes: [LONG_TOKEN, "sha256:" + "cd".repeat(64)],
  at: "2026-10-07T18:00:00.000Z",
  startHref: "https://room.trydemigod.com/?start=room",
};

// --- css plumbing -----------------------------------------------------------

const styleOf = html => {
  const match = html.match(/<style>([\s\S]*?)<\/style>/);
  assert.ok(match, "rendered page must carry an inline <style> block");
  return match[1];
};

// Split a stylesheet into { selectors: string[], declarations: string }.
// Comments are stripped first so a comment sitting between rules cannot glue
// itself onto the following selector.
const rulesOf = css =>
  css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("}")
    .map(chunk => chunk.split("{"))
    .filter(([sel, decl]) => sel !== undefined && decl !== undefined)
    .map(([sel, decl]) => ({
      selectors: sel.split(",").map(s => s.trim()),
      declarations: decl,
    }));

const wrappingDecl = decl =>
  /overflow-wrap\s*:\s*(anywhere|break-word)/.test(decl) ||
  /word-break\s*:\s*break-(word|all)/.test(decl);

// --- detail page ------------------------------------------------------------

test("receipt detail h1 wraps long unbroken titles", () => {
  const html = renderReceiptDetailHtml(hostileReceipt);
  assert.ok(html.includes(LONG_TOKEN), "hostile title must reach the page");
  const style = styleOf(html);
  const h1Rules = rulesOf(style).filter(rule =>
    rule.selectors.some(sel => sel === "h1" || /(^|[\s>+~])h1$/.test(sel))
  );
  assert.ok(h1Rules.length, "inline style must have a rule targeting h1");
  assert.ok(
    h1Rules.some(rule => wrappingDecl(rule.declarations)),
    `an h1 rule must wrap long tokens; got: ${h1Rules.map(r => r.declarations.trim()).join(" | ")}`
  );
});

test("receipt detail hashes and PR links stay wrapped", () => {
  const html = renderReceiptDetailHtml(hostileReceipt);
  const style = styleOf(html);
  const detailRule = rulesOf(style).find(rule => rule.selectors.includes(".detail"));
  assert.ok(detailRule, "inline style must keep a .detail rule");
  assert.ok(
    wrappingDecl(detailRule.declarations),
    `.detail rule must wrap hashes and URLs; got: ${detailRule.declarations.trim()}`
  );
});

test("receipts list cards keep their wrapping", () => {
  const html = renderReceiptsHtml({ receipts: [hostileReceipt], nextCursor: null });
  const style = styleOf(html);
  const cardRule = rulesOf(style).find(rule => rule.selectors.includes(".card"));
  assert.ok(cardRule, "inline style must keep a .card rule");
  assert.ok(
    wrappingDecl(cardRule.declarations),
    `.card rule must wrap long titles; got: ${cardRule.declarations.trim()}`
  );
});

// --- in-app receipt card ----------------------------------------------------

test("in-app .receipt p wraps reporter-supplied text", () => {
  const css = readFileSync(join(repoRoot, "src", "styles.css"), "utf8");
  const receiptPRules = rulesOf(css).filter(rule => rule.selectors.includes(".receipt p"));
  assert.ok(receiptPRules.length, "src/styles.css must have a .receipt p rule");
  assert.ok(
    receiptPRules.some(rule => wrappingDecl(rule.declarations)),
    `.receipt p must wrap long summary/nextAction text; got: ${receiptPRules.map(r => r.declarations.trim()).join(" | ")}`
  );
});

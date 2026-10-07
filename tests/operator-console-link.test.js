// Operator-console link contract (underutilized-features audit, lane 3).
// /operator.html is deployment-level and token-gated; the app may link it
// ONLY from the owner-gated Room health settings panel, with the
// ownership-is-not-access note. A link anywhere else (nav, footer, guest
// surface) is a regression: it advertises a destructive-capability surface
// to people who can never hold the operator token.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const html = readFileSync(join(repoRoot, "index.html"), "utf8");
const appJs = readFileSync(join(repoRoot, "src", "app.js"), "utf8");

// The #room-health <details> block: from its opening tag to the first
// closing </details> (the panel has no nested <details>).
function roomHealthBlock() {
  const open = html.indexOf('<details id="room-health"');
  assert.notEqual(open, -1, "index.html must contain the #room-health panel");
  const close = html.indexOf("</details>", open);
  assert.notEqual(close, -1, "#room-health panel must close");
  return html.slice(open, close);
}

test("operator console is linked exactly once in index.html", () => {
  const hits = html.match(/href="\/operator\.html"/g) || [];
  assert.equal(hits.length, 1, `expected exactly one /operator.html link, found ${hits.length}`);
});

test("operator console link lives inside the owner-gated Room health panel", () => {
  const block = roomHealthBlock();
  assert.match(block, /<a[^>]*id="operator-console-link"[^>]*href="\/operator\.html"/,
    "the /operator.html link must sit inside the #room-health panel");
});

test("operator console link opens in a new tab without opener access", () => {
  const block = roomHealthBlock();
  const tag = block.match(/<a[^>]*id="operator-console-link"[^>]*>/)?.[0];
  assert.ok(tag, "operator console link must exist");
  assert.match(tag, /target="_blank"/, "link must open in a new tab");
  assert.match(tag, /rel="[^"]*noopener/, "link must carry rel=noopener");
});

test("the panel states that room ownership is not operator access", () => {
  const block = roomHealthBlock().toLowerCase();
  assert.ok(block.includes("operator token"),
    "the panel must mention the operator token");
  assert.ok(block.includes("ownership") && (block.includes("alone") || block.includes("does not grant")),
    "the panel must say ownership alone does not grant access");
});

test("the Room health panel stays hidden from non-owners", () => {
  // Shipped HTML defaults the panel to hidden.
  assert.match(html, /<details id="room-health"[^>]*\bhidden\b/,
    "#room-health must ship with the hidden attribute");
  // The only client code that unhides it gates on the human room owner.
  const fn = appJs.match(/function syncRoomHealth\(\) \{[\s\S]*?\n\}/);
  assert.ok(fn, "src/app.js must define syncRoomHealth");
  assert.ok(fn[0].includes("#room-health"), "syncRoomHealth must target #room-health");
  assert.ok(fn[0].includes(".hidden ="), "syncRoomHealth must toggle hidden");
  assert.ok(fn[0].includes("ownerId"), "syncRoomHealth must gate on room ownership");
});

test("no guest-visible surface links to the operator console", () => {
  // The link contract is: exactly one link, inside the owner-gated panel.
  // Removing it from the panel or adding a second link anywhere breaks the
  // first two tests; this one names the intent for the next editor.
  const block = roomHealthBlock();
  const outside = html.replace(block, "");
  assert.ok(!outside.includes("/operator.html"),
    "no /operator.html reference may appear outside the owner-gated panel");
});

// QA 2026-10-03 (P1-1): the served shell must be a real page for no-JS
// strangers, slow connections and crawlers — not an empty "Connecting to
// room service…" shell. The contracts, in priority order:
//
// 1. A no-JS fetch sees only the wordmark and an enable-JavaScript message.
// 2. Link-preview crawlers get OG/Twitter metadata.
// 3. The landing has no educational links or invite pitch.
// 4. The hero says plainly that the live room needs JavaScript, via <noscript>.
// 5. Real browser acceptance owns removal on boot and visible sign-in actions.
//
// These read index.html itself because the server serves that file verbatim
// (server/http.mjs reads it from disk) — the bytes ARE the contract. The
// retention bar keeps source inspection here: the assertion is on
// user-facing content, and it fails exactly when the contract changes.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

test("the no-JS shell is a minimal wordmark and enable message", () => {
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /PROJECT ROOM/);
  assert.match(hero, /<noscript>[\s\S]*Enable JavaScript to sign in\.[\s\S]*<\/noscript>/);
  assert.equal((hero.match(/<p[ >]/g) ?? []).length, 2, "only wordmark and JavaScript guidance");
  assert.ok(!/<a[ >]|<button[ >]/.test(hero), "no extra entry links or actions");
});

test("link-preview metadata is present", () => {
  // Landed on main alongside this work (canonical + og:image); the contract
  // is that crawlers get a complete preview card, whatever the exact copy.
  assert.match(html, /<meta property="og:title" content="Project Room"/, "og:title");
  assert.match(html, /<meta property="og:description" content="Project Room/, "og:description");
  assert.match(html, /<meta property="og:url" content="https:\/\/room\.trydemigod\.com\/"/, "og:url");
  assert.match(html, /<meta property="og:image" content="https:\/\/room\.trydemigod\.com\/og\/home\.png"/, "og:image");
  assert.match(html, /<meta name="twitter:card" content="summary_large_image"/, "twitter:card");
});

test("the hero keeps its styles and semantics CSP-clean", () => {
  // CSP is style-src 'self' + no inline scripts: the hero must render from the
  // external stylesheet and static markup only.
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  assert.ok(!hero.includes("<style"), "no inline <style> inside the hero");
  assert.ok(!hero.includes("<script"), "no inline <script> inside the hero");
  assert.match(hero, /aria-label="Project Room"/, "landmark label");
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.static-hero \{/, "hero styles live in the external stylesheet");
});

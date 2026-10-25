// QA 2026-10-03 (P1-1): the served shell must be a real page for no-JS
// strangers, slow connections and crawlers — not an empty "Connecting to
// room service…" shell. The contracts, in priority order:
//
// 1. A no-JS fetch sees the wordmark as a true heading, the citable
//    definition block (AEO Lane 3, 2026-10-17: the /about definition
//    passage, server-rendered so crawlers and answer engines can quote
//    the root page) and an enable-JavaScript message.
// 2. Link-preview crawlers get OG/Twitter metadata.
// 3. DOOR-CURE-1 (2026-10-25, stranger-door D1 rows 2+20): the landing
//    hero is a door, not prose only — it carries real CTA anchors to
//    join / agent sign-in, /offers, /receipts and the /agents directory,
//    so a no-JS stranger has an above-the-fold next step. (This reverses
//    the earlier prose-only contract, which left the hero with 0 anchors.)
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

test("the no-JS shell is the wordmark heading, the definition block, the CTA anchors and the enable message", () => {
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /<h1 class="static-hero-title">PROJECT ROOM<\/h1>/, "the hero title is a true heading, not a <p>");
  assert.match(hero, /Project Room is a shared room where people and AI agents work together\./, "citable definition from /about");
  assert.match(hero, /every finished result ends in a receipt/, "receipt outcome stated");
  assert.match(hero, /public when the room's owner chooses to publish it/, "receipts are public only by the owner's choice (#3594)");
  assert.doesNotMatch(hero, /ends in a public receipt/, "no public-by-default promise");
  assert.match(hero, /one HTTP call enrolls an agent/, "how an agent joins stated");
  assert.match(hero, /<noscript>[\s\S]*Enable JavaScript to sign in\.[\s\S]*<\/noscript>/);
  assert.equal((hero.match(/<p[ >]/g) ?? []).length, 4, "two definition paragraphs, the CTA link row and JavaScript guidance");
  // DOOR-CURE-1: real CTA anchors in the served hero — a no-JS stranger
  // can join / sign in, browse open work, read receipts and find agents
  // without waiting for the app to boot.
  for (const href of ["/join", "/agent-signin", "/offers", "/receipts", "/agents"]) {
    assert.match(hero, new RegExp(`<a href="${href}">`), `hero carries a CTA anchor to ${href}`);
  }
  assert.ok(!/<button[ >]/.test(hero), "hero CTAs are anchors, not JS-only buttons");
});

test("the landing footer links the agent directory where it links offers and receipts (DOOR-CURE-1 row 20)", () => {
  const footer = html.slice(html.indexOf('<footer class="site-footer">'), html.indexOf("</footer>", html.indexOf('<footer class="site-footer">')));
  assert.match(footer, /<a href="\/offers">Open work<\/a>/);
  assert.match(footer, /<a href="\/receipts">Receipts<\/a>/);
  assert.match(footer, /<a href="\/agents">Agent directory<\/a>/, "homepage footer carries the /agents directory link");
});

test("the root carries SoftwareApplication JSON-LD and a claim-shaped description", () => {
  const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(match => JSON.parse(match[1]));
  const app = blocks.find(block => block["@type"] === "SoftwareApplication");
  assert.ok(app, "SoftwareApplication JSON-LD present");
  assert.equal(app.name, "Project Room");
  assert.equal(app.url, "https://room.trydemigod.com/");
  assert.ok(!html.includes("hang out"), "the vague hang-out description is gone");
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

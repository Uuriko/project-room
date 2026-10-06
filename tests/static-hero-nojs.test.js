// QA 2026-10-03 (P1-1): the served shell must be a real page for no-JS
// strangers, slow connections and crawlers — not an empty "Connecting to
// room service…" shell. The contracts, in priority order:
//
// 1. A no-JS fetch of / sees the value prop (headline + what it is).
// 2. Link-preview crawlers get OG/Twitter metadata.
// 3. The hero points at real doors: the join guide and the agent entry card.
// 4. The hero says plainly that the live room needs JavaScript, via <noscript>.
// 5. The app removes the hero on boot so it never double-renders.
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

test("the shell carries the no-JS hero with the value prop", () => {
  assert.match(html, /<section id="static-hero"[^>]*>/, "hero section present");
  // The page keeps its single h1 ("PROJECT ROOM", the auth panel title) —
  // public-pages-hygiene enforces one h1 per page — so the hero headline is
  // a styled paragraph, still the visual headline for no-JS visitors.
  assert.match(html, /<p class="static-hero-title">People and agents\. One conversation\.<\/p>/, "headline");
  assert.match(
    html,
    /open shared space where people and AI agents hang out, talk, and do accountable work together/,
    "what-it-is copy"
  );
});

test("the hero links the real doors", () => {
  assert.match(html, /<a href="\/about">Join guide<\/a>/, "join guide is the human product guide");
  assert.match(html, /<a href="\/agents\.json">/, "agent entry card");
});

test("human-labeled hero links do not point at agent-only docs", () => {
  // Issue #1597: the static hero's "Join guide" once pointed at /llms.txt
  // (the 324-line agent protocol doc), while the app's own convention
  // (index.html auth-hero comment) is "/about for the guide, /llms.txt for
  // agents". A non-technical human's first click landed in curl commands.
  // Agent-only docs stay on agent-labeled surfaces ("Agent entry card").
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  const agentOnly = [
    "/llms.txt", "/llms-full.txt", "/join.txt", "/kits.txt",
    "/agents.json", "/.well-known/agent.json", "/SKILL.md", "/skill.md",
    "/agents.md", "/AGENTS.md",
  ];
  for (const [, href, label] of hero.matchAll(/<a href="([^"]+)">([^<]*)<\/a>/g)) {
    if (agentOnly.includes(href)) {
      assert.match(label, /agent/i, `agent-only doc ${href} must sit on an agent-labeled link, got "${label}"`);
    }
  }
  assert.ok(!hero.includes('href="/llms.txt">Join guide</a>'), "#1597: Join guide no longer targets /llms.txt");
});

test("the hero tells JS-off visitors the live room needs JavaScript", () => {
  assert.match(html, /<noscript>[\s\S]*JavaScript is off[\s\S]*<\/noscript>/, "noscript guidance");
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
  assert.match(hero, /aria-label="About Project Room"/, "landmark label");
  const css = readFileSync(fileURLToPath(new URL("../src/styles.css", import.meta.url)), "utf8");
  assert.match(css, /\.static-hero \{/, "hero styles live in the external stylesheet");
});

test("the app removes the static hero on boot", () => {
  // Owner boundary for the removal is a real browser journey; this is the
  // cheapest independent guard that the boot path still tears the hero down.
  const app = readFileSync(fileURLToPath(new URL("../src/app.js", import.meta.url)), "utf8");
  assert.match(app, /#static-hero/, "boot references the hero");
  assert.match(app, /\$\("#static-hero"\)\?\.remove\(\)/, "boot removes it before any render");
});

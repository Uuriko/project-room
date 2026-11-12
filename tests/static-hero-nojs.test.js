// No-JavaScript entry retains selectable onboarding routes, host consent,
// load recovery and link-preview metadata. The removed watch action stays absent.
// Browser tests separately qualify boot, copied instructions and sign-in.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");

test("the no-JS shell is the wordmark, the definition block and the enable message", () => {
  const hero = html.match(/<section id="static-hero"[\s\S]*?<\/section>/)[0];
  assert.match(hero, /Project Room/);
  assert.match(hero, /connects the AI agents you already use/);
  assert.match(hero, /href="\/docs\/agents\/paste"/,'existing-agent connection is available without JavaScript');
  assert.doesNotMatch(hero, /href="\/watch"/, 'removed watch action does not return in the no-JS entry');
  assert.match(hero, /href="\/llms\.txt"/, 'agent instructions remain available without JavaScript');
  assert.match(hero, /host may ask you to approve/,'host consent is explained honestly');
  assert.doesNotMatch(hero, /every finished result ends in a receipt|one HTTP call enrolls an agent/,'do not promise universal results or host setup');
  assert.match(hero, /<noscript>[\s\S]*Enable JavaScript to sign in\.[\s\S]*<\/noscript>/);
  const recovery = hero.match(/<div id="entry-load-recovery" hidden>[\s\S]*?<\/div>/)?.[0];
  assert.ok(recovery, 'load recovery stays hidden unless JavaScript detects a failure');
  assert.match(recovery, /id="entry-load-retry"/, 'failed JavaScript loading has an explicit retry');
  const visibleHero = hero.replace(recovery, '');
  // L2-H1-1: the visible hero must offer a working path in without JavaScript.
  // The recovery block was stripped above, so a match here is outside the
  // hidden retry and therefore visible in the static markup.
  assert.ok(!/<button[ >]/.test(visibleHero), "retry stays inside hidden recovery; visible entry works through links");

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
  assert.match(html, /<meta property="og:title" content="Project Room[^\"]+"/, "og:title");
  assert.match(html, /<meta property="og:description" content="Connect the AI agents/, "og:description");
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
  assert.match(css, /\.static-hero-links a \{/, "the join link is styled by the external stylesheet, not inline or unstyled");
});

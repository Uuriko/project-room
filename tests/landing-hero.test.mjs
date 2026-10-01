// RC-2026-09-30-3650 (human-door P0-1): the logged-out landing hero.
// Authoring gate (test-audit SKILL.md):
//  1. Contract: GET / renders a visible hero inside #auth-panel carrying the
//     product tagline (the meta-description sentence, rendered not hidden)
//     plus guide/agent links that resolve to live routes. This is the
//     independent guard for the human-door P0-1 fix — a logged-out human
//     must see what Project Room is and where to go, not a bare sign-in wall.
//  2. Credible regression: someone removes #auth-hero, rewrites the tagline
//     away, or points a hero link at a dead route (notably bare /join, which
//     errors without an invite token — the 2026-09-28 P1 finding).
//  3. Existing coverage: join-page.test.js owns /join; nothing asserts the
//     landing hero, its copy, or that its link targets serve 200.
//  4. No production seam: real server + real HTTP, same pattern as
//     join-page.test.js. HTML ids/copy are the user-facing contract here.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-landing-hero-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin, ownerKey };
}

function heroSection(html) {
  const start = html.indexOf('id="auth-hero"');
  assert.ok(start !== -1, "landing page has #auth-hero");
  const end = html.indexOf("</section>", start);
  assert.ok(end !== -1, "#auth-hero section closes");
  return html.slice(start, end);
}

test("logged-out landing renders a visible hero in the auth panel", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /text\/html/);
  const html = await response.text();

  // The hero lives inside the logged-out auth panel, right after the brand
  // heading — not hidden behind a disclosure or a meta tag.
  const panelStart = html.indexOf('id="auth-panel"');
  const heroStart = html.indexOf('id="auth-hero"');
  assert.ok(panelStart !== -1 && heroStart > panelStart, "#auth-hero is inside #auth-panel");

  // The meta-description sentence, rendered visibly (human-door P0-1).
  const hero = heroSection(html);
  assert.ok(
    hero.includes("An open shared space where people and AI agents hang out, talk, and do accountable work together."),
    "hero renders the product tagline",
  );

  // Guide/agent links point at live routes.
  assert.ok(hero.includes('href="/about"'), "hero links the product guide");
  assert.ok(hero.includes('href="/llms.txt"'), "hero links the agent setup guide");
  // The bare /join page is not a real entry point without an invite token
  // (2026-09-28 P1): the hero must not promise it.
  assert.ok(!hero.includes('href="/join"'), "hero does not link bare /join");
});

test("hero link targets resolve", async t => {
  const { origin } = await serve(t);
  for (const path of ["/about", "/llms.txt"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, `${path} serves 200`);
  }
});

// ROOM_MVP_ONLY marks the front door so the MVP-only CSS applies.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { frontDoorHtml, mvpOnlyEnabled } from "../server/github-oauth.mjs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");

test("ROOM_MVP_ONLY parses only 1 or true", () => {
  assert.equal(mvpOnlyEnabled({ ROOM_MVP_ONLY: "1" }), true);
  assert.equal(mvpOnlyEnabled({ ROOM_MVP_ONLY: "true" }), true);
  for (const value of [undefined, "", "0", "false", "yes"]) assert.equal(mvpOnlyEnabled({ ROOM_MVP_ONLY: value }), false);
});

test("front door carries data-mvp-only only when the flag is on", () => {
  assert.match(html, /<html lang="en">/, "index.html keeps the plain root tag the flag rewrites");
  assert.doesNotMatch(frontDoorHtml(html), /data-mvp-only/);
  assert.match(frontDoorHtml(html, { mvpOnly: true }), /<html lang="en" data-mvp-only>/);
  assert.match(frontDoorHtml(html, { mvpOnly: true, githubConfigured: true }), /data-mvp-only/);
});

test("the MVP-only rules hide non-MVP panels and pin needs-me", () => {
  const css = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
  for (const id of ["#cockpit-money", "#usage-grid", "#spend-figures", "#chat-suggestions"]) assert.ok(css.includes(`html[data-mvp-only] ${id}`), id);
  assert.match(css, /html\[data-mvp-only\] #needs-attention \{\s*position: sticky;/);
});

test('MVP_ONLY client switch is off without the html marker and the trim covers roster and composer extras', async () => {
  const { MVP_ONLY } = await import('../src/room-layout.js');
  assert.equal(MVP_ONLY, false);
  const css = (await import('node:fs')).readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  for (const sel of ['#people-panel', '#room-more', '#composer-attach', '[data-message-action="pin"]']) assert.ok(css.includes(`html[data-mvp-only] ${sel}`), sel);
  assert.ok(!css.includes('html[data-mvp-only] #topbar-updates'), 'Needs me lives in Updates and must stay');
});

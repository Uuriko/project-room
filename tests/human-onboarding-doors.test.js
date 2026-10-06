// Human-UX (#1596): docs/HUMAN-ONBOARDING.md is the graded B+ one-page human
// guide, but no public page linked to it — a stranger at any public door
// could not find it. Contract: the public doors surface it.
//
// - GET / (index.html): the logged-out auth-hero nav carries
//   "New here? Start here" pointing at /about#onboarding.
// - GET /about (about.html): carries the onboarding section and links the
//   full guide at its public URL.
//
// Served bytes are the contract (same pattern as public-pages-hygiene and
// public-search-http): the server reads these files from disk verbatim, so
// a dropped link fails here exactly when the #1596 gap recurs.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";

const ONBOARDING_DOC_URL = "https://github.com/Uuriko/project-room/blob/main/docs/HUMAN-ONBOARDING.md";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "room-human-onboarding-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const authHeroNav = html => {
  const section = html.match(/<section id="auth-hero"[\s\S]*?<\/section>/);
  assert.ok(section, "auth-hero section present in served /");
  const nav = section[0].match(/<nav class="auth-hero-links"[\s\S]*?<\/nav>/);
  assert.ok(nav, "auth-hero nav present");
  return nav[0];
};

test("GET / auth-hero nav links 'New here? Start here' at /about#onboarding", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  const nav = authHeroNav(await response.text());
  assert.match(nav, /<a href="\/about#onboarding">New here\? Start here<\/a>/,
    "strangers see the onboarding door in the logged-out hero");
});

test("GET /about carries the onboarding section and links the full human guide", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/about`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /id="onboarding"/, "onboarding anchor present");
  assert.match(html, /New here\? Start here/, "onboarding heading copy present");
  assert.ok(html.includes(`href="${ONBOARDING_DOC_URL}"`), "links the full guide at its public URL");
});

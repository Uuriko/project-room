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
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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

test("GET / keeps product education out of the minimal sign-in entry", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status,200);
  const html = await response.text();
  assert.match(html,/<h1 id="auth-title"[^>]*>PROJECT ROOM<\/h1>/);
  assert.ok(!html.includes('id="auth-hero"'));
  const auth = html.match(/<section id="auth-panel"[\s\S]*?<\/section>/)[0];
  assert.equal((auth.match(/id="agent-signin-button"/g) ?? []).length, 1);
  assert.ok(!/href="(?:\/about|\/agents\.json|[^"]*#join-agent)/.test(auth), "education stays outside sign-in");
});

test("GET / offers GitHub sign-in beside Google on the front door", async t => {
  const origin = await serve(t);
  const response = await fetch(`${origin}/`);
  assert.equal(response.status, 200);
  const html = await response.text();
  const auth = html.match(/<section id="auth-panel"[\s\S]*?<\/section>/)[0];
  const google = auth.indexOf('id="google-signin"');
  const github = auth.indexOf('id="github-signin"');
  assert.ok(google >= 0, "the panel still leads with the Google button");
  assert.ok(github > google, "GitHub sits beside Google inside the sign-in methods");
  assert.match(auth, /<a id="github-signin" class="button secondary" href="\/api\/auth\/github\/start">/);
  assert.match(auth, /Continue with GitHub/);
  // Parity with Google in app.js: the pending-invite stash runs before the
  // OAuth navigation, and the welcome view hides the button.
  const app = readFileSync(new URL("../src/app.js", import.meta.url), "utf8");
  assert.match(app, /\$\("#github-signin"\)\.hidden = view === "welcome";/);
  const stash = app.match(/githubButton\.addEventListener\("click", stashInviteForOAuth\)/);
  assert.ok(stash, "GitHub anchor stashes a pending invite like Google does");
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

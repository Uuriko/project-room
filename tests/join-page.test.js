import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { createRoomServer } from "../server/http.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

async function serve(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-join-page-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom("commons"));
  const ownerKey = store.issueAccessKey("commons", "owner");
  const server = createRoomServer({ store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); rmSync(directory, { recursive: true, force: true }); });
  return { origin, ownerKey };
}

test("join page is public: GET /join and /join/:code serve the page without auth", async t => {
  const { origin } = await serve(t);
  for (const path of ["/join", "/join/", "/join/RM-EXAMPLE", "/room/join", "/room/join/RM-EXAMPLE"]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="join-form"/, `${path} has the join form`);
    assert.match(html, /id="join-consent"/, `${path} has the consent screen`);
    assert.match(html, /id="join-error"/, `${path} has the error screen`);
    // QA 2026-09-29: the /join/ error pages were dead ends with no way back.
    assert.match(html, /id="join-home-link" href="\/(room\/)?"/, `${path} error screen links back to sign-in`);
    assert.match(html, /href="https:\/\/www\.getdasha\.com\/room"/, `${path} error screen links to the marketing page`);
    assert.match(html, /id="join-session-expiry"/, `${path} has the session-expiry line on the success screen`);
    assert.match(html, /src="[^"]*\/src\/join\.js"/, `${path} loads the join script`);
    assert.ok(!html.includes("{{ASSET_BASE}}"), `${path} substitutes the asset base`);
  }
});

test("join page asset base follows the door", async t => {
  const { origin } = await serve(t);
  const root = await (await fetch(`${origin}/join/RM-EXAMPLE`)).text();
  assert.match(root, /src="\/src\/join\.js"/);
  // B1 regression: the stylesheet href must point at the served asset path,
  // not the unserved /styles.css (404 on both doors pre-fix).
  assert.match(root, /href="\/src\/styles\.css"/);
  const door = await (await fetch(`${origin}/room/join/RM-EXAMPLE`)).text();
  assert.match(door, /src="\/room\/src\/join\.js"/);
  assert.match(door, /href="\/room\/src\/styles\.css"/);
});

test("join page assets resolve on both doors (B1+B2)", async t => {
  const { origin } = await serve(t);
  // The exact URLs the rendered join page references must serve 200 with
  // correct content types — through the /room/src/* edge rewrite on the
  // www door twin. Pre-fix: /room/src/join.js 404'd and boot() never ran.
  for (const [path, type] of [
    ["/src/styles.css", /text\/css/],
    ["/src/join.js", /javascript/],
    ["/room/src/styles.css", /text\/css/],
    ["/room/src/join.js", /javascript/],
  ]) {
    const res = await fetch(`${origin}${path}`);
    assert.equal(res.status, 200, `${path} serves`);
    assert.match(res.headers.get("content-type") ?? "", type, `${path} content type`);
  }
});

test("join page route boundaries", async t => {
  const { origin } = await serve(t);
  const post = await fetch(`${origin}/join/RM-EXAMPLE`, { method: "POST" });
  assert.equal(post.status, 405);
  const extra = await fetch(`${origin}/join/RM-EXAMPLE/extra`);
  assert.equal(extra.status, 404);
  const joinHtml = await (await fetch(`${origin}/join.html`)).text();
  assert.match(joinHtml, /id="join-form"/);
});

test("D-c: malformed invite codes render the join page with the sign-in fallback, not a bare 404", async t => {
  // Remedy validated by Scribble, room seq 2207. Before the fix, codes that
  // fail the [A-Za-z0-9_-]{1,64} shape fell through to the generic 404 page
  // (no sign-in link, no invite context) — a dead end. The join page's
  // client-side boot() rejects the malformed code and shows the error screen,
  // which carries the "Back to sign-in" fallback.
  const { origin } = await serve(t);
  for (const path of ["/join/!!!", "/join/" + "A".repeat(65), "/join/" + "A".repeat(128), "/room/join/!!!", "/room/join/" + "A".repeat(65)]) {
    const response = await fetch(`${origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.match(response.headers.get("content-type"), /text\/html/);
    const html = await response.text();
    assert.match(html, /id="join-error"/, `${path} has the error screen`);
    assert.match(html, /id="join-home-link"/, `${path} error screen links back to sign-in`);
  }
  // Multi-segment paths still 404.
  const extra = await fetch(`${origin}/join/!!!/extra`);
  assert.equal(extra.status, 404);
});

test("full self-serve flow: mint invite, preview the consent screen, join by code", async t => {
  const { origin, ownerKey } = await serve(t);
  const roomId = "commons";
  const minted = await (await fetch(`${origin}/api/rooms/${roomId}/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute" }),
  })).json();
  assert.match(minted.code, /^RM-/);

  const preview = await (await fetch(`${origin}/api/agent-invites/preview?code=${minted.code}`)).json();
  assert.equal(preview.roomId, roomId);
  assert.ok(Array.isArray(preview.permissions) && preview.permissions.length > 0);
  assert.ok(preview.expiresAt > Date.now());

  const joined = await (await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Join Page Agent", inviteCode: minted.code }),
  })).json();
  assert.equal(joined.roomId, roomId);
  assert.equal(joined.via, "invite");
  assert.equal(typeof joined.identitySecret, "string");
  // The invite branch hands out the room-scoped rak_ token, never the identity
  // secret. It is named honestly as roomToken; identitySecret is the alias.
  assert.equal(joined.credentialKind, "room_token");
  assert.match(joined.roomToken, /^rak_/);
  assert.equal(joined.identitySecret, joined.roomToken);
  assert.equal(joined.roomToken, joined.mcpToken.credential);
  // Identity-wide routes refuse it with a reason that does not send the agent
  // off to mint a replacement identity.
  for (const path of ["/api/agent-rooms", "/api/needs-me"]) {
    const refused = await fetch(`${origin}${path}`, { headers: { Authorization: `Bearer ${joined.roomToken}` } });
    assert.equal(refused.status, 401, path);
    const refusal = await refused.json();
    assert.equal(refusal.error.code, "room_token_not_identity", path);
    assert.match(refusal.error.message, /room-scoped token/, path);
    assert.doesNotMatch(refusal.error.message, /self-mint/, path);
  }
  const created = await fetch(`${origin}/api/agent-rooms`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${joined.roomToken}` },
    body: JSON.stringify({ title: "Second room", purpose: "should be refused" }),
  });
  assert.equal(created.status, 401);
  assert.equal((await created.json()).error.code, "room_token_not_identity");

  // The code is single-use: the join page's consent screen now reports it dead.
  const previewAgain = await fetch(`${origin}/api/agent-invites/preview?code=${minted.code}`);
  assert.equal(previewAgain.status, 409);

  // Raw-code CLI redemption still works on a fresh invite.
  const minted2 = await (await fetch(`${origin}/api/rooms/${roomId}/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "chat" }),
  })).json();
  const raw = await (await fetch(`${origin}/api/agent-invites/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: minted2.code, displayName: "CLI Peer" }),
  })).json();
  assert.equal(raw.roomId, roomId);
});

test("join by invite sets a working browser session cookie for the new member", async t => {
  const { origin, ownerKey } = await serve(t);
  const roomId = "commons";
  const minted = await (await fetch(`${origin}/api/rooms/${roomId}/agent-invites`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ownerKey}` },
    body: JSON.stringify({ profile: "contribute" }),
  })).json();
  const response = await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "Session Agent", inviteCode: minted.code }),
  });
  assert.equal(response.status, 201);
  const joined = await response.json();
  assert.equal(joined.session, true);
  // The join response carries the session row's genuine expiry (8h TTL):
  // the welcome screen renders it as a real date/time, never a guess.
  const eightHours = 8 * 3600 * 1000;
  assert.ok(Number.isSafeInteger(joined.sessionExpiresAt), "join returns sessionExpiresAt");
  assert.ok(joined.sessionExpiresAt > Date.now(), "expiry is in the future");
  assert.ok(joined.sessionExpiresAt <= Date.now() + eightHours + 60_000, "expiry matches the 8h session TTL");
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "join sets a session cookie");
  assert.match(setCookie, /room_session=[^;]+;.*HttpOnly/);
  const cookie = setCookie.split(";")[0];
  // The cookie authenticates the new member: the room snapshot loads as them.
  const snapshot = await (await fetch(`${origin}/api/rooms/${roomId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(snapshot.viewerId, joined.memberId);
  assert.equal(snapshot.state.members[joined.memberId].displayName, "Session Agent");
  // And they can participate: the app fetches its CSRF token from /api/session,
  // then posting a message works through the session like any browser client.
  const sessionView = await (await fetch(`${origin}/api/session`, { headers: { Cookie: cookie } })).json();
  assert.equal(typeof sessionView.csrf, "string");
  // The expiry the join response reported is the session's real expiry.
  assert.equal(sessionView.expiresAt, joined.sessionExpiresAt);
  const posted = await fetch(`${origin}/api/rooms/${roomId}/commands`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: origin, "X-CSRF-Token": sessionView.csrf },
    body: JSON.stringify({ id: "msg-1", type: "message.posted", data: { body: "Hello from the join page" } }),
  });
  assert.equal(posted.status, 201);
});

test("first-room join also signs the browser in", async t => {
  const { origin } = await serve(t);
  const response = await fetch(`${origin}/api/join`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ displayName: "First Room Agent" }),
  });
  assert.equal(response.status, 201);
  const joined = await response.json();
  assert.equal(joined.session, true);
  // First-room joins mint the same 8h browser session: the response carries
  // its genuine expiry for the welcome screen.
  assert.ok(Number.isSafeInteger(joined.sessionExpiresAt), "first-room join returns sessionExpiresAt");
  assert.ok(joined.sessionExpiresAt > Date.now(), "expiry is in the future");
  assert.ok(joined.sessionExpiresAt <= Date.now() + 8 * 3600 * 1000 + 60_000, "expiry matches the 8h session TTL");
  const cookie = response.headers.get("set-cookie").split(";")[0];
  const snapshot = await (await fetch(`${origin}/api/rooms/${joined.roomId}`, { headers: { Cookie: cookie } })).json();
  assert.equal(snapshot.viewerId, joined.memberId);
});

test("join page no-JS fallback gives working, host-correct agent instructions", async t => {
  // Slice E stranger QA: the noscript fallback named a fictional endpoint
  // (POST /api/agents/enroll exists nowhere in the codebase) and hardcoded
  // the production origin + muse-room, so a no-JS stranger on a self-hosted
  // server was instructed to enroll into the wrong server via a 404 route.
  const { origin } = await serve(t);
  const html = await (await fetch(`${origin}/join/RM-EXAMPLE`)).text();
  const noscript = html.match(/<noscript>[\s\S]*?<\/noscript>/);
  assert.ok(noscript, "join page has a noscript fallback");
  const block = noscript[0];
  assert.ok(!block.includes("/api/agents/enroll"), "no fictional enroll endpoint");
  assert.ok(!block.includes("https://room.trydemigod.com"), "no hardcoded production origin");
  assert.ok(!block.includes('"roomId":"muse-room"') && !block.includes("muse-room"), "no hardcoded room id");
  assert.match(block, /\/llms\.txt/, "points agents at the serving host's agent packet");
});

test("join page loader cannot stick forever: external watchdog ships a no-invite fallback (#1608)", async t => {
  // #1608: /join with no invite token sat on "Loading your invite…" forever
  // when src/join.js never executed (blocked, failed, or stalled module).
  // The watchdog is a classic external script, loaded before the module:
  // the page is served with CSP script-src 'self' (no 'unsafe-inline'), so
  // an inline watchdog would be blocked by the browser. Cheapest
  // independent guards: the served page carries no inline scripts, loads
  // the watchdog ahead of the module, and the watchdog file itself ships
  // the user-facing fallback copy.
  const { origin } = await serve(t);
  for (const [pagePath, watchdogPath] of [["/join", "/src/join-watchdog.js"], ["/room/join", "/room/src/join-watchdog.js"]]) {
    const html = await (await fetch(`${origin}${pagePath}`)).text();
    assert.match(html, /id="join-loading"/, `${pagePath} has the loader card`);
    const inlineScripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
    assert.equal(inlineScripts.length, 0, `${pagePath} has no inline scripts (CSP script-src 'self')`);
    const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"[^>]*><\/script>/g)].map(m => m[1]);
    assert.ok(scripts.includes(watchdogPath), `${pagePath} loads the watchdog`);
    assert.ok(scripts.indexOf(watchdogPath) < scripts.findIndex(s => /\/join\.js$/.test(s)),
      `${pagePath} loads the watchdog before the module`);
    const res = await fetch(`${origin}${watchdogPath}`);
    assert.equal(res.status, 200, `${watchdogPath} serves`);
    assert.match(res.headers.get("content-type") ?? "", /javascript/, `${watchdogPath} content type`);
    const watchdog = await res.text();
    assert.match(watchdog, /join-loading/, "watchdog watches the loader card");
    assert.match(watchdog, /No invite found/, "watchdog ships the no-invite fallback copy");
    assert.match(watchdog, /ask a room owner for an invite link/i, "watchdog fallback names the next step");
    assert.ok(!html.includes("{{ASSET_BASE}}"), `${pagePath} substitutes the asset base`);
  }
});

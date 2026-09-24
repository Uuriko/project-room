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
    assert.match(html, /id="join-session-expiry"/, `${path} has the session-expiry line on the success screen`);
    assert.match(html, /src="[^"]*\/src\/join\.js"/, `${path} loads the join script`);
    assert.ok(!html.includes("{{ASSET_BASE}}"), `${path} substitutes the asset base`);
  }
});

test("join page asset base follows the door", async t => {
  const { origin } = await serve(t);
  const root = await (await fetch(`${origin}/join/RM-EXAMPLE`)).text();
  assert.match(root, /src="\/src\/join\.js"/);
  const door = await (await fetch(`${origin}/room/join/RM-EXAMPLE`)).text();
  assert.match(door, /src="\/room\/src\/join\.js"/);
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

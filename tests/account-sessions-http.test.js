// HTTP tests for CX4 account-session inventory + targeted revocation:
// GET /api/account/sessions and DELETE /api/account/sessions/:id.
//
// The gap these pin (native audit muse12998/12999): the native desktop
// sign-in exchanges its PKCE code at POST /api/auth/desktop/session, which
// retires the whole temporary OAuth grant and keeps only an account-session
// slot. The session the Mac app actually holds therefore never appeared in
// GET /api/oauth/sessions, and POST /api/oauth/sessions/revoke-all — an
// OAuth-only promise — could not end it. These tests exercise the REAL
// chain (desktop redemption first, OAuth tokens never stand in for the
// native session):
//
//   desktop redemption -> authenticated native read/stream -> inventory
//   from a second authorized session of the same account -> targeted
//   revoke -> native cookie/read/stream denied; the revoking session and
//   another account's sessions stay valid.
//
// Client leg (not re-tested here): the denial the revoked client sees is
// the canonical 401 session death; src/conversation.js
// shouldPreserveDrafts() classifies 401/403 expiry as "preserve" and
// src/app.js onAccessEnded() then requests sign-in without clearing
// drafts — pinned by tests/draft-session-expiry.test.js.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { initialRoom } from "../server/bootstrap.mjs";

const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = createHash("sha256").update(VERIFIER).digest("base64url");
const CLIENT = { clientId: "muse-qa", name: "Muse QA", redirectUris: ["https://muse.ai/callback"] };
const ACCOUNT_COOKIE = "account_session";
const cookiePair = token => `${ACCOUNT_COOKIE}=${token}`;

async function startServer(t, { streamInterval } = {}) {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const server = createRoomServer({
    store: fixture.store,
    magicLinkMailer: createMagicLinkMailer({ send: async payload => { sent.push(payload); } }),
    connectorClients: [CLIENT],
    streamInterval,
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, sent, store: fixture.store };
}

const cookieOf = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")[1];

// A fresh anonymous slot -> magic code -> signed-in browser session.
// Returns the live cookie token; csrf/binding are read fresh per call via
// viewOf, exactly as a client would after the login rotation.
async function magicLogin(origin, sent, email) {
  const slotRes = await fetch(`${origin}/api/account-session`);
  const slotView = await slotRes.json();
  const slotToken = cookieOf(slotRes);
  const post = (path, body, tok, csrf) => fetch(origin + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookiePair(tok), "X-CSRF-Token": csrf, Origin: origin },
    body: JSON.stringify(body),
  });
  const request = await post("/api/auth/magic/request", { email }, slotToken, slotView.csrf);
  assert.equal(request.status, 200);
  const code = sent.at(-1).code;
  const res = await post("/api/auth/magic/consume",
    { email, code, sessionToken: slotToken, sessionRevision: slotView.sessionRevision }, slotToken, slotView.csrf);
  assert.equal(res.status, 201);
  return { token: cookieOf(res) };
}

async function viewOf(origin, token) {
  const res = await fetch(`${origin}/api/account-session`, { headers: { Cookie: cookiePair(token) } });
  assert.equal(res.status, 200);
  return res.json();
}

const readHeaders = (session, view) => ({ Cookie: cookiePair(session.token), "X-Session-Binding": view.sessionBinding });
const writeHeaders = (origin, session, view) => ({
  ...readHeaders(session, view), Origin: origin, "X-CSRF-Token": view.csrf, "Content-Type": "application/json",
});

async function listAccountSessions(origin, session) {
  const view = await viewOf(origin, session.token);
  const res = await fetch(`${origin}/api/account/sessions`, { headers: readHeaders(session, view) });
  assert.equal(res.status, 200);
  return (await res.json()).sessions;
}

// The full native chain, mirroring the desktop test in
// oauth-authorize-http.test.js: start -> consent (browser session of the
// same account) -> callback -> PKCE exchange with NO browser cookie, so
// the native client receives its own independent account-session cookie.
async function desktopRedeem(origin, browser) {
  const browserView = await viewOf(origin, browser.token);
  const state = "s".repeat(43);
  const start = await fetch(`${origin}/api/auth/desktop/start?state=${state}&challenge=${CHALLENGE}`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"), origin);
  const params = Object.fromEntries(authorize.searchParams);
  const allowed = await fetch(`${origin}/oauth/authorize`, {
    method: "POST", redirect: "manual",
    headers: { "Content-Type": "application/json", Cookie: cookiePair(browser.token), "X-CSRF-Token": browserView.csrf, Origin: origin },
    body: JSON.stringify({ ...params, decision: "allow" }),
  });
  assert.equal(allowed.status, 302);
  const callback = new URL(allowed.headers.get("location"));
  assert.equal(callback.pathname, "/api/auth/desktop/callback");
  const returned = await fetch(callback, { redirect: "manual" });
  assert.equal(returned.status, 302);
  const code = new URL(returned.headers.get("location")).searchParams.get("code");
  assert.ok(code);
  const exchange = await fetch(`${origin}/api/auth/desktop/session`, {
    method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify({ code, verifier: VERIFIER }),
  });
  assert.equal(exchange.status, 201);
  assert.deepEqual(await exchange.json(), { status: "signed_in" });
  return { token: cookieOf(exchange) };
}

const nativeRead = (origin, native) =>
  fetch(`${origin}/api/auth/methods`, { headers: { Cookie: cookiePair(native.token) } });

async function roomRead(origin, native, roomId) {
  const view = await viewOf(origin, native.token);
  return fetch(`${origin}/api/rooms/${roomId}`, {
    headers: { Cookie: cookiePair(native.token), "X-Session-Binding": view.sessionBinding, "X-Project-Room-Auth": "account" },
  });
}

async function streamConnect(origin, native, roomId) {
  const view = await viewOf(origin, native.token);
  const controller = new AbortController();
  try {
    const res = await fetch(`${origin}/api/rooms/${roomId}/stream`, {
      headers: {
        Cookie: cookiePair(native.token), "X-Session-Binding": view.sessionBinding,
        "X-Project-Room-Auth": "account", Accept: "text/event-stream",
      },
      signal: controller.signal,
    });
    return { status: res.status, contentType: res.headers.get("content-type") };
  } finally {
    controller.abort();
  }
}

const revokeOne = (origin, session, id, view) => fetch(`${origin}/api/account/sessions/${id}`, {
  method: "DELETE", headers: writeHeaders(origin, session, view),
});

test("native chain: desktop redemption -> native read/stream -> targeted revoke from a second session -> native denied", async t => {
  const { origin, sent, store } = await startServer(t);
  const browser = await magicLogin(origin, sent, "cx4-alice@example.com");
  const native = await desktopRedeem(origin, browser);

  // The native session is a separate slot for the same account.
  const nativeView = await viewOf(origin, native.token);
  const browserView = await viewOf(origin, browser.token);
  assert.equal(nativeView.authenticated, true);
  assert.equal(nativeView.account.id, browserView.account.id);
  assert.notEqual(nativeView.sessionBinding, browserView.sessionBinding);

  // Authenticated native reads work: account surface, a bound room read,
  // and the room stream. (A dedicated room: the fixture's commons humans
  // are already bound to legacy accounts.)
  assert.equal((await nativeRead(origin, native)).status, 200);
  store.initialize(initialRoom("cx4-native-room"));
  store.bindHumanAccount("cx4-native-room", "owner", nativeView.account.id);
  assert.equal((await roomRead(origin, native, "cx4-native-room")).status, 200);
  const stream = await streamConnect(origin, native, "cx4-native-room");
  assert.equal(stream.status, 200);
  assert.match(stream.contentType, /text\/event-stream/);

  // Inventory from the browser session (a second authorized session of
  // the same account): both sessions listed; the native one is the
  // desktop-method entry and is not the caller's current session.
  const sessions = await listAccountSessions(origin, browser);
  assert.equal(sessions.length, 2);
  const desktop = sessions.find(session => session.method === "desktop");
  assert.ok(desktop, "the native session is listed as a desktop session");
  assert.equal(desktop.methodRef, "project-room-macos");
  assert.equal(desktop.current, false);
  assert.match(desktop.id, /^acs_[0-9a-f]{24}$/);
  const own = sessions.find(session => session.current);
  assert.equal(own.method, "magic");
  // The OAuth inventory never contained the native session (its grant
  // was retired at redemption): zero families, before and after.
  const oauthList = await fetch(`${origin}/api/oauth/sessions`, { headers: readHeaders(browser, browserView) });
  assert.equal((await oauthList.json()).sessions.length, 0);

  // Targeted revoke of exactly the native session.
  const kill = await revokeOne(origin, browser, desktop.id, await viewOf(origin, browser.token));
  assert.equal(kill.status, 200);
  assert.deepEqual(await kill.json(), { revoked: 1 });

  // The native credential is dead on every surface: its slot view is
  // anonymous again, account reads refuse, the inventory refuses, room
  // reads and stream connects refuse.
  assert.equal((await viewOf(origin, native.token)).authenticated, false);
  assert.equal((await nativeRead(origin, native)).status, 401);
  const nativeList = await fetch(`${origin}/api/account/sessions`, {
    headers: { Cookie: cookiePair(native.token), "X-Session-Binding": nativeView.sessionBinding },
  });
  assert.equal(nativeList.status, 401);
  assert.equal((await roomRead(origin, native, "cx4-native-room")).status, 401);
  assert.equal((await streamConnect(origin, native, "cx4-native-room")).status, 401);

  // The revoking browser session is untouched and now lists only itself.
  assert.equal((await fetch(`${origin}/api/auth/methods`, { headers: { Cookie: cookiePair(browser.token) } })).status, 200);
  const remaining = await listAccountSessions(origin, browser);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].current, true);
});

test("OAuth revoke-all keeps its OAuth-only semantics: it does not reach the native account session", async t => {
  const { origin, sent } = await startServer(t);
  const browser = await magicLogin(origin, sent, "cx4-carol@example.com");
  const native = await desktopRedeem(origin, browser);
  const browserView = await viewOf(origin, browser.token);

  // Give the account a real OAuth family so revoke-all has OAuth work to do.
  const verifier = ("v-" + browser.token).slice(0, 43).padEnd(43, "f");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authz = "/oauth/authorize?response_type=code&client_id=" + CLIENT.clientId
    + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
    + "&scope=" + encodeURIComponent("chat:read")
    + "&state=s1&code_challenge=" + challenge + "&code_challenge_method=S256";
  const screen = await fetch(origin + authz, { headers: { Cookie: cookiePair(browser.token) } });
  assert.equal(screen.status, 200);
  const csrf = (await screen.text()).match(/name="csrf_token" value="([^"]+)"/)[1];
  const consent = await fetch(origin + "/oauth/authorize", {
    method: "POST", redirect: "manual",
    headers: { "content-type": "application/x-www-form-urlencoded", Cookie: cookiePair(browser.token), Origin: origin },
    body: "decision=allow&client_id=" + CLIENT.clientId
      + "&redirect_uri=" + encodeURIComponent(CLIENT.redirectUris[0])
      + "&scope=chat%3Aread&state=s1&code_challenge=" + challenge
      + "&code_challenge_method=S256&csrf_token=" + encodeURIComponent(csrf),
  });
  assert.equal(consent.status, 302);
  const code = new URL(consent.headers.get("location")).searchParams.get("code");
  const tokenRes = await fetch(origin + "/oauth/token", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUris[0], code_verifier: verifier }),
  });
  assert.equal(tokenRes.status, 200);
  const oauthBefore = await fetch(`${origin}/api/oauth/sessions`, { headers: readHeaders(browser, browserView) });
  assert.equal((await oauthBefore.json()).sessions.length, 1);

  // Revoke-all kills the OAuth family — and nothing else.
  const revokeAll = await fetch(`${origin}/api/oauth/sessions/revoke-all`, {
    method: "POST", headers: writeHeaders(origin, browser, await viewOf(origin, browser.token)), body: "{}",
  });
  assert.equal(revokeAll.status, 200);
  assert.equal((await revokeAll.json()).revoked, 2);
  const oauthAfter = await fetch(`${origin}/api/oauth/sessions`, { headers: readHeaders(browser, browserView) });
  assert.equal((await oauthAfter.json()).sessions.length, 0);

  // The native account session survives OAuth revoke-all (it was never an
  // OAuth session) and still authenticates; only the targeted account-
  // session path ends it.
  assert.equal((await nativeRead(origin, native)).status, 200);
  const sessions = await listAccountSessions(origin, browser);
  assert.equal(sessions.length, 2);
  const desktop = sessions.find(session => session.method === "desktop");
  const kill = await revokeOne(origin, browser, desktop.id, await viewOf(origin, browser.token));
  assert.equal(kill.status, 200);
  assert.equal((await nativeRead(origin, native)).status, 401);
});

test("inventory boundaries: anonymous refused, writes need CSRF, cross-account and repeat revokes answer 404", async t => {
  const { origin, sent } = await startServer(t);
  const alice = await magicLogin(origin, sent, "cx4-dana@example.com");
  const bob = await magicLogin(origin, sent, "cx4-erin@example.com");
  const native = await desktopRedeem(origin, alice);

  // Anonymous callers are refused before any session data.
  const anonList = await fetch(`${origin}/api/account/sessions`);
  assert.equal(anonList.status, 401);
  assert.equal((await anonList.json()).error.code, "account_session_required");
  const anonKill = await fetch(`${origin}/api/account/sessions/acs_0123456789abcdef01234567`, { method: "DELETE" });
  assert.equal(anonKill.status, 401);

  // Bob sees only his own session.
  const bobSessions = await listAccountSessions(origin, bob);
  assert.equal(bobSessions.length, 1);
  assert.equal(bobSessions[0].current, true);
  assert.equal(bobSessions[0].method, "magic");

  const aliceSessions = await listAccountSessions(origin, alice);
  const desktop = aliceSessions.find(session => session.method === "desktop");
  assert.ok(desktop);

  // Cross-account revoke: 404 with the same code as an unknown id, and
  // the target session is untouched.
  const bobView = await viewOf(origin, bob.token);
  const cross = await revokeOne(origin, bob, desktop.id, bobView);
  assert.equal(cross.status, 404);
  assert.equal((await cross.json()).error.code, "session_not_found");
  assert.equal((await nativeRead(origin, native)).status, 200);

  // Unknown id: identical 404 shape (no probing).
  const aliceView = await viewOf(origin, alice.token);
  const unknown = await revokeOne(origin, alice, "acs_0123456789abcdef01234567", aliceView);
  assert.equal(unknown.status, 404);
  assert.equal((await unknown.json()).error.code, "session_not_found");

  // The write is CSRF-protected like the OAuth family: no token, no kill.
  const noCsrf = await fetch(`${origin}/api/account/sessions/${desktop.id}`, {
    method: "DELETE", headers: readHeaders(alice, aliceView),
  });
  assert.equal(noCsrf.status, 403);
  assert.equal((await nativeRead(origin, native)).status, 200);

  // The real revoke works exactly once; a repeat answers 404.
  const kill = await revokeOne(origin, alice, desktop.id, await viewOf(origin, alice.token));
  assert.equal(kill.status, 200);
  const again = await revokeOne(origin, alice, desktop.id, await viewOf(origin, alice.token));
  assert.equal(again.status, 404);

  // Bob's session is valid throughout.
  assert.equal((await fetch(`${origin}/api/auth/methods`, { headers: { Cookie: cookiePair(bob.token) } })).status, 200);
  assert.equal((await listAccountSessions(origin, bob)).length, 1);
});

test("store inventory: methods recorded at login, rotation carries them, sign-out and credential death unlist a session", async t => {
  const fixture = createAcceptanceFixture();
  const store = fixture.store;
  t.after(() => store.close());
  store.createAccount("cx4-store-alice");
  store.createAccount("cx4-store-bob");

  // Access-key login records kind "access-key".
  const key = store.issueAccountAccessKey("cx4-store-alice");
  const slotA = store.createAccountSessionSlot();
  const authA = store.loginAccountSession(slotA.token, key, 0);
  // A desktop-shaped login on a second slot.
  const slotB = store.createAccountSessionSlot();
  const authB = store.loginAccountSessionWithMethod(slotB.token, "cx4-store-alice", 0,
    { method: { kind: "desktop", ref: "project-room-macos" } });

  let sessions = store.listAccountSessions("cx4-store-alice", authB.credentialHash);
  assert.equal(sessions.length, 2);
  const accessKey = sessions.find(session => session.method === "access-key");
  const desktop = sessions.find(session => session.method === "desktop");
  assert.ok(accessKey && desktop);
  assert.equal(desktop.methodRef, "project-room-macos");
  assert.equal(desktop.current, true);
  assert.equal(accessKey.current, false);

  // Sessions minted before methods were recorded report method null
  // (simulate the pre-CX4 row by clearing the columns directly).
  store.db.prepare("UPDATE account_session_slots SET login_method_kind=NULL, login_method_ref=NULL WHERE hash=?").run(authA.credentialHash);
  sessions = store.listAccountSessions("cx4-store-alice");
  assert.equal(sessions.find(session => session.id === accessKey.id).method, null);
  store.db.prepare("UPDATE account_session_slots SET login_method_kind='access-key' WHERE hash=?").run(authA.credentialHash);

  // Rotation carries the recorded method onto the fresh slot row (under
  // that row's own new inventory id).
  const rotated = store.rotateAccountSessionSlot(slotB.token);
  sessions = store.listAccountSessions("cx4-store-alice", rotated.session.credentialHash);
  assert.equal(sessions.length, 2);
  const rotatedDesktop = sessions.find(session => session.current);
  assert.equal(rotatedDesktop.method, "desktop");

  // Targeted revoke: wrong account and garbage ids answer 0; the right
  // account answers 1 exactly once.
  assert.equal(store.revokeAccountSession("cx4-store-bob", rotatedDesktop.id), 0);
  assert.equal(store.revokeAccountSession("cx4-store-alice", "acs_nope"), 0);
  assert.equal(store.revokeAccountSession("cx4-store-alice", rotatedDesktop.id), 1);
  assert.equal(store.revokeAccountSession("cx4-store-alice", rotatedDesktop.id), 0);
  assert.equal(store.listAccountSessions("cx4-store-alice").length, 1);

  // Sign-out unlists the caller's own slot.
  const current = store.authenticateAccountSession(slotA.token);
  store.logoutAccountSession(slotA.token, current.sessionRevision);
  assert.equal(store.listAccountSessions("cx4-store-alice").length, 0);

  // A session whose parent credential dies is no longer live: it leaves
  // the inventory and stops authenticating.
  const slotC = store.createAccountSessionSlot();
  const authC = store.loginAccountSessionWithMethod(slotC.token, "cx4-store-alice", 0,
    { method: { kind: "magic", ref: "method-1" } });
  assert.equal(store.listAccountSessions("cx4-store-alice").length, 1);
  const parent = store.db.prepare("SELECT parent_credential_hash AS hash FROM account_session_slots WHERE hash=?").get(authC.credentialHash).hash;
  store.db.prepare("UPDATE account_credentials SET revoked=1 WHERE hash=?").run(parent);
  assert.equal(store.listAccountSessions("cx4-store-alice").length, 0);
  assert.throws(() => store.authenticateAccountSession(slotC.token), /revoked/);
});

test("targeted native revoke closes an already-open real HTTP stream", { timeout: 15000 }, async t => {
  const { origin, sent, store } = await startServer(t, { streamInterval: 10 });
  const browser = await magicLogin(origin, sent, "stream-review@example.com");
  const native = await desktopRedeem(origin, browser);
  const view = await viewOf(origin, native.token);
  store.initialize(initialRoom("held-stream"));
  store.bindHumanAccount("held-stream", "owner", view.account.id);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${origin}/api/rooms/held-stream/stream`, {
    headers: { ...readHeaders(native, view), "X-Project-Room-Auth": "account", Accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(stream.status, 200);
  const reader = stream.body.getReader();
  await reader.read();
  const desktop = (await listAccountSessions(origin, browser)).find(item => item.method === "desktop");
  const revoked = await revokeOne(origin, browser, desktop.id, await viewOf(origin, browser.token));
  assert.equal(revoked.status, 200);
  let tail = "";
  const timeout = setTimeout(() => controller.abort(), 3000);
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      tail += new TextDecoder().decode(value);
    }
  } finally { clearTimeout(timeout); }
  assert.match(tail, /event: access-ended/);
  assert.equal((await listAccountSessions(origin, browser)).length, 1);
});

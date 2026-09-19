// QAS-702 (RC-2026-09-19-069) session-fixation tests: every login path mints
// a FRESH account_session slot token and invalidates the pre-login one, so a
// token planted before sign-in can never authenticate afterwards.
//
// Boots a real server against an acceptance-fixture store over loopback; the
// magic mailer is an injected memory mailer. No network, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { createMagicLinkMailer } from "../server/magic-links.mjs";
import { RoomStore } from "../server/store.mjs";

async function startServer(t) {
  const fixture = createAcceptanceFixture();
  const sent = [];
  const mailer = createMagicLinkMailer({ send: async payload => { sent.push(payload); } });
  const server = createRoomServer({ store: fixture.store, magicLinkMailer: mailer });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    fixture.store.close();
  });
  return { origin: `http://127.0.0.1:${server.address().port}`, store: fixture.store, sent };
}

async function openSlot(origin) {
  const res = await fetch(`${origin}/api/account-session`);
  assert.equal(res.status, 200);
  const view = await res.json();
  const match = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "");
  assert.ok(match, "slot cookie is set");
  return { cookie: match[1], csrf: view.csrf, revision: view.sessionRevision };
}

const accountCookie = res => /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")?.[1] ?? null;

const post = (origin, path, { cookie, csrf, body }) => fetch(origin + path, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    Cookie: `account_session=${cookie}`,
    "X-CSRF-Token": csrf,
    Origin: origin
  },
  body: JSON.stringify(body)
});

const getSession = (origin, cookie) => fetch(`${origin}/api/account-session`, {
  headers: { Cookie: `account_session=${cookie}` }
});

test("magic-link consume mints a fresh slot token and kills the planted one", async t => {
  const { origin, store, sent } = await startServer(t);
  // Attacker plants slot token P in the victim's browser before sign-in.
  const planted = await openSlot(origin);
  const email = "fixation-victim@example.com";

  const requested = await post(origin, "/api/auth/magic/request", {
    cookie: planted.cookie, csrf: planted.csrf, body: { email }
  });
  assert.equal(requested.status, 200);
  const consumed = await post(origin, "/api/auth/magic/consume", {
    cookie: planted.cookie, csrf: planted.csrf,
    body: { email, code: sent[0].code, sessionToken: planted.cookie, sessionRevision: planted.revision }
  });
  assert.equal(consumed.status, 201);
  const view = await consumed.json();
  assert.equal(view.authenticated, true);

  const fresh = accountCookie(consumed);
  assert.ok(fresh, "login sets the fresh slot cookie");
  assert.notEqual(fresh, planted.cookie, "the slot token rotates at login");

  // The planted token is dead: it authenticates nothing.
  assert.throws(() => store.authenticateAccountSession(planted.cookie), { code: "unauthenticated" });
  const plantedGet = await getSession(origin, planted.cookie);
  assert.equal(plantedGet.status, 200);
  assert.equal((await plantedGet.json()).authenticated, false);

  // The fresh token carries the victim's session.
  const freshGet = await getSession(origin, fresh);
  assert.equal(freshGet.status, 200);
  const freshView = await freshGet.json();
  assert.equal(freshView.authenticated, true);
  assert.equal(freshView.account.id, view.account.id);
  assert.equal(freshView.sessionRevision, view.sessionRevision, "revision carries over, no state jump");
});

test("password login mints a fresh slot token and kills the planted one", async t => {
  const { origin, store } = await startServer(t);
  const planted = await openSlot(origin);
  const email = "fixation-password@example.com";
  const password = "fixation-password-long-enough";

  const signup = await post(origin, "/api/auth/password/signup", {
    cookie: planted.cookie, csrf: planted.csrf,
    body: { email, password, sessionToken: planted.cookie, sessionRevision: planted.revision }
  });
  assert.equal(signup.status, 201);
  const fresh = accountCookie(signup);
  assert.ok(fresh && fresh !== planted.cookie, "signup rotates the slot token");
  assert.throws(() => store.authenticateAccountSession(planted.cookie), { code: "unauthenticated" });

  // A second login on the fresh token rotates again: each login retires
  // the token it arrived on.
  const slot = await openSlot(origin);
  const login = await post(origin, "/api/auth/password/login", {
    cookie: slot.cookie, csrf: slot.csrf,
    body: { email, password, sessionToken: slot.cookie, sessionRevision: slot.revision }
  });
  assert.equal(login.status, 200);
  const fresh2 = accountCookie(login);
  assert.ok(fresh2 && fresh2 !== slot.cookie, "login rotates the slot token");
  assert.throws(() => store.authenticateAccountSession(slot.cookie), { code: "unauthenticated" });
  assert.equal(store.authenticateAccountSession(fresh2).account.id,
    (await login.json()).account.id);
});

test("store: rotateAccountSessionSlot preserves state and retires the old token", async t => {
  const directory = mkdtempSync(join(tmpdir(), "session-fixation-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => 1700000000000 });
  t.after(() => store.close());
  const slot = store.createAccountSessionSlot();
  const preLoginCsrf = store.accountSessionSlot(slot.token).csrf;
  store.createAccount("acct-fix", "test");
  const loggedIn = store.loginAccountSessionWithMethod(slot.token, "acct-fix", 0,
    { method: { kind: "password", ref: "lm_test" }, rotateSlot: true });
  assert.ok(loggedIn.token, "rotation returns the fresh token");
  assert.notEqual(loggedIn.token, slot.token, "the token actually changes");
  assert.equal(loggedIn.session.account.id, "acct-fix");
  assert.equal(loggedIn.session.sessionRevision, 1, "revision carries over");
  assert.notEqual(loggedIn.session.csrf, preLoginCsrf, "CSRF is bound to the fresh token");
  assert.throws(() => store.authenticateAccountSession(slot.token), { code: "unauthenticated" },
    "the pre-login token is invalidated");
  // The fresh token is a fully working session.
  assert.equal(store.authenticateAccountSession(loggedIn.token).account.id, "acct-fix");
});

test("store: rotation refuses anonymous slots and unknown tokens", async t => {
  const directory = mkdtempSync(join(tmpdir(), "session-fixation-"));
  const store = new RoomStore(join(directory, "room.sqlite"), { now: () => 1700000000000 });
  t.after(() => store.close());
  const anon = store.createAccountSessionSlot();
  assert.throws(() => store.rotateAccountSessionSlot(anon.token), { code: "slot_not_authenticated" });
  assert.throws(() => store.rotateAccountSessionSlot("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"),
    { code: "unauthenticated" });
  // Without the rotate flag the legacy in-place upgrade still works.
  store.createAccount("acct-legacy", "test");
  const kept = store.loginAccountSessionWithMethod(anon.token, "acct-legacy", 0, { method: { kind: "x", ref: "lm" } });
  assert.equal(store.authenticateAccountSession(anon.token).account.id, "acct-legacy");
  assert.equal(kept.account.id, "acct-legacy");
});

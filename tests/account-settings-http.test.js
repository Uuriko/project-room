// HTTP integration tests for the login-method settings routes in
// server/http.mjs (slice 7, RC-2026-09-17-016): GET /api/auth/methods,
// POST /api/auth/methods/{disable,enable,remove},
// POST /api/auth/password/set, and the GitHub link-intent flow
// (GET /api/auth/github/link/start + the slice-4 callback with link=true).
// Boots a real server against an acceptance-fixture store over loopback;
// GitHub's endpoints are mocked; no network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { GITHUB_CALLBACK_PATH } from "../server/github-oauth.mjs";

const clientId = "Iv1.fixtureclientid0000";
const clientSecret = "fixture-secret-never-real";
const userId = 424242;
const verifiedEmail = "gh-user@example.com";

function githubFetch({ id = userId, emails } = {}) {
  return async url => {
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_fixture-token-never-real", token_type: "bearer", scope: "read:user,user:email" });
    }
    if (url === "https://api.github.com/user") return Response.json({ id, login: "octofixture" });
    if (url === "https://api.github.com/user/emails") {
      return Response.json(emails ?? [
        { email: "other@example.com", primary: false, verified: true },
        { email: verifiedEmail, primary: true, verified: true }
      ]);
    }
    return new Response("missing", { status: 404 });
  };
}

async function startServer(t, f, options = {}) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  return `http://127.0.0.1:${server.address().port}`;
}

const post = (origin, path, data, cookie = null) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(data)
});
const get = (origin, path, creds = null, { redirect = "follow" } = {}) => {
  const cookie = typeof creds === "string" ? creds : creds?.cookie;
  const csrf = typeof creds === "string" ? null : creds?.csrf;
  return fetch(origin + path, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(csrf ? { "X-CSRF-Token": csrf } : {}) }, redirect
  });
};

const password = n => `fixture-password-${n}-long-enough`;

// An authenticated session cookie for the account, built directly on the store.
function authCookie(f, accountId, withMethod = null) {
  const slot = f.store.createAccountSessionSlot();
  const revision = slot.session.sessionRevision;
  if (withMethod) f.store.loginAccountSessionWithMethod(slot.token, accountId, revision, { method: withMethod });
  else f.store.loginAccountSession(slot.token, f.store.issueAccountAccessKey(accountId), revision);
  // Signing in rotates the CSRF token: re-read the slot.
  return { cookie: `account_session=${slot.token}`, csrf: f.store.accountSessionSlot(slot.token).csrf };
}
// Authenticated POST for the settings mutations: cookie slot + CSRF header.
const authedPost = (origin, path, data, creds) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie, "X-CSRF-Token": creds.csrf },
  body: JSON.stringify(data)
});

async function passwordAccount(t, n) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = `slice7-${n}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup",
    { email, password: password(n), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(res.status, 201);
  const body = await res.json();
  // QAS-702: signup rotates the slot token — the fresh cookie (and the
  // response's csrf) is the session; the presented token is dead.
  const fresh = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  assert.ok(fresh, "signup sets the rotated slot cookie");
  return { f, origin, accountId: body.account.id, email,
    creds: { cookie: `account_session=${fresh}`, csrf: body.csrf } };
}

const errBody = async res => (await res.json()).error;

test("GET /api/auth/methods requires an authenticated session", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  assert.equal((await get(origin, "/api/auth/methods")).status, 401);
  const anon = f.store.createAccountSessionSlot();
  assert.equal((await get(origin, "/api/auth/methods", `account_session=${anon.token}`)).status, 401);
});

test("GET /api/auth/methods lists safe descriptors and provider status", async t => {
  const { origin, accountId, creds } = await passwordAccount(t, 1);
  const res = await get(origin, "/api/auth/methods", creds.cookie);
  assert.equal(res.status, 200);
  const body = await res.json();
  const types = body.methods.map(m => m.type).sort();
  assert.deepEqual(types, ["magic", "password"]);
  for (const method of body.methods) {
    assert.ok(method.id && method.label, "descriptor carries id and label");
    assert.ok(Number.isSafeInteger(method.createdAt), "descriptor carries createdAt");
    assert.equal("verifier" in method, false, "verifiers are never exposed");
    assert.equal("externalSubject" in method, false, "subjects are never exposed");
  }
  assert.deepEqual(Object.keys(body.providers).sort(), ["github", "google", "mail", "passkey"]);
  for (const provider of Object.values(body.providers)) {
    assert.equal(typeof provider.configured, "boolean");
  }
  assert.equal(body.providers.github.configured, false);
  assert.equal(body.providers.google.configured, false);
  assert.equal(body.providers.mail.configured, false);
  void accountId;
});

test("disable/enable/remove mutate one method; the last active method is protected", async t => {
  const { f, origin, accountId, creds } = await passwordAccount(t, 2);
  const methods = () => f.store.accountLogins.listMethods(accountId);
  const passwordMethod = methods().find(m => m.type === "password");
  const magicMethod = methods().find(m => m.type === "magic");

  let res = await authedPost(origin, "/api/auth/methods/disable", { id: passwordMethod.id }, creds);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).method.disabled, true);

  // The last active method cannot be disabled.
  res = await authedPost(origin, "/api/auth/methods/disable", { id: magicMethod.id }, creds);
  assert.equal(res.status, 409);
  assert.equal((await errBody(res)).code, "last_login_method");

  res = await authedPost(origin, "/api/auth/methods/enable", { id: passwordMethod.id }, creds);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).method.disabled, false);

  // Removing the only disabled method is fine; removing the last active one is not.
  res = await authedPost(origin, "/api/auth/methods/remove", { id: magicMethod.id }, creds);
  assert.equal(res.status, 200);
  assert.deepEqual((await res.json()), { removed: true, id: magicMethod.id, type: "magic" });
  assert.equal(methods().some(m => m.id === magicMethod.id), false);

  res = await authedPost(origin, "/api/auth/methods/remove", { id: passwordMethod.id }, creds);
  assert.equal(res.status, 409);
  assert.equal((await errBody(res)).code, "last_login_method");
  assert.equal(methods().some(m => m.id === passwordMethod.id), true);
});

test("method mutations validate input and session", async t => {
  const { origin, creds } = await passwordAccount(t, 3);
  assert.equal((await authedPost(origin, "/api/auth/methods/disable", { id: "nope" }, creds)).status, 404);
  assert.equal((await errBody(await authedPost(origin, "/api/auth/methods/disable", { id: "nope" }, creds))).code, "login_method_not_found");
  const missing = await authedPost(origin, "/api/auth/methods/disable", {}, creds);
  assert.equal(missing.status, 422);
  assert.equal((await errBody(missing)).code, "invalid_method");
  assert.equal((await post(origin, "/api/auth/methods/remove", { id: "x" })).status, 401);
  assert.equal((await get(origin, "/api/auth/methods/disable", creds.cookie)).status, 405);
  // Mutations without the CSRF token are rejected.
  const noCsrf = await post(origin, "/api/auth/methods/disable", { id: "nope" }, creds.cookie);
  assert.equal(noCsrf.status, 403);
  assert.equal((await errBody(noCsrf)).code, "csrf_denied");
});

test("POST /api/auth/password/set attaches a first password to a magic-only account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "slice7-magic@example.invalid";
  const accountId = `email:${createHash("sha256").update(email, "utf8").digest("hex")}`;
  f.store.createAccount(accountId, "magic-fixture");
  const method = f.store.accountLogins.linkMagicMethod(accountId, { email });
  const creds = authCookie(f, accountId, { kind: "magic", ref: method.id });

  const res = await authedPost(origin, "/api/auth/password/set", { password: password(9) }, creds);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.status, "ok");
  const types = f.store.accountLogins.listMethods(accountId).map(m => m.type).sort();
  assert.deepEqual(types, ["magic", "password"]);

  // A second set 409s: the account already has a password.
  const again = await authedPost(origin, "/api/auth/password/set", { password: password(10) }, creds);
  assert.equal(again.status, 409);
  assert.equal((await errBody(again)).code, "password_already_set");

  // The new password actually signs in.
  const slot = f.store.createAccountSessionSlot();
  const login = await post(origin, "/api/auth/password/login",
    { email, password: password(9), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(login.status, 200);
});

test("POST /api/auth/password/set validates policy, email, and session", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "slice7-magic2@example.invalid";
  const accountId = `email:${createHash("sha256").update(email, "utf8").digest("hex")}`;
  f.store.createAccount(accountId, "magic-fixture");
  const method = f.store.accountLogins.linkMagicMethod(accountId, { email });
  const creds = authCookie(f, accountId, { kind: "magic", ref: method.id });

  const short = await authedPost(origin, "/api/auth/password/set", { password: "short" }, creds);
  assert.equal(short.status, 422);
  assert.equal((await errBody(short)).code, "password_too_short");
  assert.equal((await post(origin, "/api/auth/password/set", { password: password(11) })).status, 401);

  // An OAuth-only account with no verified email cannot set a password.
  f.store.createAccount("github:999", "github-oauth");
  f.store.accountLogins.linkOAuthMethod("github:999", { provider: "github", subject: "999" });
  const oauthCreds = authCookie(f, "github:999", { kind: "oauth", ref: "github:999" });
  const noEmail = await authedPost(origin, "/api/auth/password/set", { password: password(12) }, oauthCreds);
  assert.equal(noEmail.status, 422);
  assert.equal((await errBody(noEmail)).code, "no_verified_email");
});

test("GET /api/auth/github/link/start 401s anonymously, 503s when GitHub is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  // Auth is checked before provider configuration: anonymous callers get
  // 401 without learning whether GitHub is configured.
  const anon = await get(origin, "/api/auth/github/link/start", null, { redirect: "manual" });
  assert.equal(anon.status, 401);

  const accountId = "link-start-503";
  f.store.createAccount(accountId, "link-start-fixture");
  const magic = f.store.accountLogins.linkMagicMethod(accountId, { email: "link503@example.invalid" });
  const creds = authCookie(f, accountId, { kind: "magic", ref: magic.id });
  const res = await get(origin, "/api/auth/github/link/start", creds.cookie, { redirect: "manual" });
  assert.equal(res.status, 503);
  assert.equal((await res.json()).reason, "github_not_configured");

  const configured = await startServer(t, createAcceptanceFixture(), { githubAuth: { clientId, clientSecret, fetchImpl: githubFetch() } });
  const anonSlot = createAcceptanceFixture().store.createAccountSessionSlot();
  const denied = await get(configured, "/api/auth/github/link/start", `account_session=${anonSlot.token}`, { redirect: "manual" });
  assert.equal(denied.status, 401);
});

test("GitHub link intent attaches the subject to the signed-in account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: { clientId, clientSecret, fetchImpl: githubFetch() } });
  const accountId = "slice7-link-account";
  f.store.createAccount(accountId, "password-signup");
  const magic = f.store.accountLogins.linkMagicMethod(accountId, { email: "linker@example.invalid" });
  const creds = authCookie(f, accountId, { kind: "magic", ref: magic.id });

  const start = await get(origin, "/api/auth/github/link/start", creds, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.origin, "https://github.com");
  const state = authorize.searchParams.get("state");
  assert.match(state || "", /^[A-Za-z0-9_-]{43}$/);

  const callback = await get(origin, `${GITHUB_CALLBACK_PATH}?code=link-fixture&state=${state}`, creds.cookie);
  assert.equal(callback.status, 200);
  const body = await callback.json();
  assert.equal(body.account.id, accountId, "link intent keeps the browser on its own account");
  const methods = f.store.accountLogins.listMethods(accountId);
  const oauth = methods.find(m => m.type === "oauth" && m.provider === "github");
  assert.ok(oauth, "the GitHub subject is linked as a method on the account");
  assert.equal(body.method.ref, oauth.id);
});

test("GitHub link intent 409s when the subject is owned by another account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: { clientId, clientSecret, fetchImpl: githubFetch() } });
  const owner = "slice7-link-owner", other = "slice7-link-other";
  f.store.createAccount(owner, "github-oauth");
  f.store.accountLogins.linkOAuthMethod(owner, { provider: "github", subject: String(userId), email: verifiedEmail });
  f.store.createAccount(other, "password-signup");
  const magic = f.store.accountLogins.linkMagicMethod(other, { email: "other-linker@example.invalid" });
  const creds = authCookie(f, other, { kind: "magic", ref: magic.id });

  const start = await get(origin, "/api/auth/github/link/start", creds, { redirect: "manual" });
  assert.equal(start.status, 302);
  const state = new URL(start.headers.get("location")).searchParams.get("state");
  const callback = await get(origin, `${GITHUB_CALLBACK_PATH}?code=link-fixture&state=${state}`, creds.cookie);
  assert.equal(callback.status, 409);
  assert.equal((await errBody(callback)).code, "login_method_exists");
  assert.equal(f.store.accountLogins.listMethods(other).filter(m => m.type === "oauth").length, 0);
});

// Sign-in through the cookie slot (slice 7): browser clients cannot read
// the HttpOnly account slot cookie, so the sign-in JSON routes accept the
// slot from the request cookie when the body omits sessionToken. The cookie
// path is CSRF-protected; omitting both the token and the cookie is a 401,
// and the cookie path without a CSRF token is a 403.

const postCookie = (origin, path, data, slot, csrf = true) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin,
    Cookie: `account_session=${slot.token}`, ...(csrf ? { "X-CSRF-Token": slot.session.csrf } : {}) },
  body: JSON.stringify(data)
});

test("password signup works through the cookie slot with CSRF", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const slot = f.store.createAccountSessionSlot();
  const res = await postCookie(origin, "/api/auth/password/signup",
    { email: "cookie-signup@example.invalid", password: password(11), sessionRevision: slot.session.sessionRevision }, slot);
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.authenticated, true);
  assert.ok(/account_session=/.test(res.headers.get("set-cookie") || ""));
});

test("password signup through the cookie slot rejects a missing CSRF token", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const slot = f.store.createAccountSessionSlot();
  const res = await postCookie(origin, "/api/auth/password/signup",
    { email: "cookie-csrf@example.invalid", password: password(12), sessionRevision: slot.session.sessionRevision }, slot, false);
  assert.equal(res.status, 403);
  assert.equal((await errBody(res)).code, "csrf_denied");
});

test("password signup without a slot is a 401", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const res = await post(origin, "/api/auth/password/signup",
    { email: "cookie-noslot@example.invalid", password: password(13), sessionRevision: 0 });
  assert.equal(res.status, 401);
  assert.equal((await errBody(res)).code, "account_session_required");
});

test("password login works through the cookie slot", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "cookie-login@example.invalid";
  const signupSlot = f.store.createAccountSessionSlot();
  const created = await postCookie(origin, "/api/auth/password/signup",
    { email, password: password(21), sessionRevision: signupSlot.session.sessionRevision }, signupSlot);
  assert.equal(created.status, 201);
  const loginSlot = f.store.createAccountSessionSlot();
  const res = await postCookie(origin, "/api/auth/password/login",
    { email, password: password(21), sessionRevision: loginSlot.session.sessionRevision }, loginSlot);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).authenticated, true);
});

test("magic consume works through the cookie slot", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "cookie-magic@example.invalid";
  const issued = f.store.accountLogins.issueMagicCode({ email });
  const slot = f.store.createAccountSessionSlot();
  const res = await postCookie(origin, "/api/auth/magic/consume",
    { email, code: issued.code, sessionRevision: slot.session.sessionRevision }, slot);
  assert.equal(res.status, 201);
  assert.equal((await res.json()).authenticated, true);
});

test("magic consume through the cookie slot rejects a missing CSRF token", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "cookie-magic-csrf@example.invalid";
  const issued = f.store.accountLogins.issueMagicCode({ email });
  const slot = f.store.createAccountSessionSlot();
  const res = await postCookie(origin, "/api/auth/magic/consume",
    { email, code: issued.code, sessionRevision: slot.session.sessionRevision }, slot, false);
  assert.equal(res.status, 403);
  assert.equal((await errBody(res)).code, "csrf_denied");
});

test("recovery redeem works through the cookie slot", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = "cookie-recovery@example.invalid";
  const signupSlot = f.store.createAccountSessionSlot();
  const created = await postCookie(origin, "/api/auth/password/signup",
    { email, password: password(22), sessionRevision: signupSlot.session.sessionRevision }, signupSlot);
  assert.equal(created.status, 201);
  const accountId = (await created.json()).account.id;
  const { codes } = f.store.accountLogins.generateRecoveryCodes(accountId);
  const slot = f.store.createAccountSessionSlot();
  const res = await postCookie(origin, "/api/auth/recovery-codes/redeem",
    { email, code: codes[0], sessionRevision: slot.session.sessionRevision }, slot);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).session.authenticated, true);
});

test("the explicit body sessionToken path still works", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const slot = f.store.createAccountSessionSlot();
  // No cookie, no CSRF: the body token is the bearer secret, as before.
  const res = await post(origin, "/api/auth/password/signup",
    { email: "body-token@example.invalid", password: password(23), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(res.status, 201);
  assert.equal((await res.json()).authenticated, true);
});

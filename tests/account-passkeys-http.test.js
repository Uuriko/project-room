// Slice 5 (RC-2026-09-17-014) HTTP tests: the four /api/auth/passkey/*
// routes in server/http.mjs.
//
// Verification is stubbed at the service boundary — a fake passkey service
// is injected through the createRoomServer passkeyService option. Real
// WebAuthn assertion crypto stays covered by src/passkey-login.mjs's own
// tests. A few tests use the real service to prove the challenge store is
// shared across requests on one server instance (options -> finish with a
// bogus response answers 401, never 500). The https-or-localhost origin
// rule's 422 branch is covered by resolvePasskeyParams unit tests in
// tests/account-passkeys.test.js (createRoomServer itself refuses
// non-loopback http origins, so the route-level 422 is defense-in-depth).
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

const jsonHeaders = { "Content-Type": "application/json" };

function fakePasskeyService() {
  const calls = [];
  const service = {
    calls,
    finishRegistrationResult: { ok: true, credentialId: "cred-http-1" },
    finishAuthenticationResult: null,
    beginRegistration: args => {
      calls.push(["beginRegistration", args]);
      return { challenge: "stub-challenge", rp: { id: args.rpId, name: args.rpId }, challengeId: "ch-reg-1" };
    },
    finishRegistration: args => {
      calls.push(["finishRegistration", args]);
      return service.finishRegistrationResult;
    },
    beginAuthentication: args => {
      calls.push(["beginAuthentication", args]);
      return { challenge: "stub-challenge", rpId: args.rpId, challengeId: "ch-auth-1" };
    },
    finishAuthentication: args => {
      calls.push(["finishAuthentication", args]);
      return service.finishAuthenticationResult ?? { ok: true, accountId: "passkey-user", methodRef: "lm_http" };
    }
  };
  return service;
}

async function startServer(t, f, options = {}, listen = ["127.0.0.1", 0]) {
  const server = createRoomServer({ store: f.store, ...options });
  await new Promise(resolve => server.listen(listen[1], listen[0], resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  return `http://${listen[0]}:${server.address().port}`;
}

function signIn(f, accountId = "passkey-user") {
  f.store.createAccount(accountId);
  const key = f.store.issueAccountAccessKey(accountId);
  const slot = f.store.createAccountSessionSlot();
  const session = f.store.loginAccountSession(slot.token, key, 0);
  return { slot, session };
}

const authedHeaders = (origin, slot, session, extra = {}) => ({
  ...jsonHeaders,
  Cookie: `account_session=${slot.token}`,
  Origin: origin,
  "X-CSRF-Token": session.csrf,
  ...extra
});

const post = (origin, path, headers, body) => fetch(origin + path, {
  method: "POST", headers, body: JSON.stringify(body ?? {})
});

const errorCode = async res => (await res.json()).error.code;

test("register options requires an authenticated account session", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  let res = await post(origin, "/api/auth/passkey/register/options", { ...jsonHeaders, Origin: origin }, {});
  assert.equal(res.status, 401);
  const anon = f.store.createAccountSessionSlot();
  res = await post(origin, "/api/auth/passkey/register/options",
    { ...jsonHeaders, Cookie: `account_session=${anon.token}`, Origin: origin }, {});
  assert.equal(res.status, 401, "anonymous slot is not an authenticated session");
});

test("register options returns ceremony options for a signed-in account", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const { slot, session } = signIn(f);
  const res = await post(origin, "/api/auth/passkey/register/options",
    authedHeaders(origin, slot, session), { userName: "Ada" });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.challengeId, "ch-reg-1");
  assert.equal(body.rp.id, "127.0.0.1");
  assert.deepEqual(service.calls[0], ["beginRegistration", {
    accountId: "passkey-user", rpId: "127.0.0.1", rpName: "127.0.0.1", userName: "Ada", authenticatorSelection: undefined
  }]);
});

test("register finish persists the credential and answers 201", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const { slot, session } = signIn(f);
  const headers = authedHeaders(origin, slot, session);
  let res = await post(origin, "/api/auth/passkey/register/finish", headers, { challengeId: "ch-reg-1", response: { id: "cred-http-1" } });
  assert.equal(res.status, 201);
  assert.deepEqual(await res.json(), { ok: true, credentialId: "cred-http-1" });
  const [, args] = service.calls.find(([name]) => name === "finishRegistration");
  assert.equal(args.accountId, "passkey-user");
  assert.equal(args.challengeId, "ch-reg-1");
  assert.equal(args.expectedOrigin, origin);
  assert.equal(args.rpId, "127.0.0.1");
  res = await post(origin, "/api/auth/passkey/register/finish", headers, { challengeId: "ch-reg-1" });
  assert.equal(res.status, 422);
  assert.equal(await errorCode(res), "invalid_passkey_response");
});

test("register finish rejects unauthenticated callers", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  const res = await post(origin, "/api/auth/passkey/register/finish",
    { ...jsonHeaders, Origin: origin }, { challengeId: "ch-reg-1", response: {} });
  assert.equal(res.status, 401);
});

test("authenticate options is anonymous and returns a challenge", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  const res = await post(origin, "/api/auth/passkey/authenticate/options", { ...jsonHeaders, Origin: origin }, {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.challengeId, "ch-auth-1");
  assert.equal(body.rpId, "127.0.0.1");
  assert.deepEqual(service.calls, [["beginAuthentication", { rpId: "127.0.0.1" }]]);
});

test("authenticate finish upgrades the slot with the passkey method", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  const origin = await startServer(t, f, { passkeyService: service });
  signIn(f); // the verified account exists
  const slot = f.store.createAccountSessionSlot(); // anonymous slot to upgrade
  const res = await post(origin, "/api/auth/passkey/authenticate/finish",
    { ...jsonHeaders, Origin: origin },
    { challengeId: "ch-auth-1", response: { id: "cred-http-1" }, sessionToken: slot.token, sessionRevision: 0 });
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.account.id, "passkey-user");
  const [, args] = service.calls.find(([name]) => name === "finishAuthentication");
  assert.equal(args.expectedOrigin, origin);
  assert.equal(args.rpId, "127.0.0.1");
  // The slot is really upgraded: the session now authenticates.
  const auth = f.store.authenticateAccountSession(slot.token);
  assert.equal(auth.account.id, "passkey-user");
});

test("authenticate finish rejects stale revisions and malformed bodies", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { passkeyService: fakePasskeyService() });
  signIn(f); // the verified account must exist for the slot upgrade
  const slot = f.store.createAccountSessionSlot();
  const headers = { ...jsonHeaders, Origin: origin };
  let res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {}, sessionToken: slot.token, sessionRevision: 0 });
  assert.equal(res.status, 200); // stub verifies; slot upgrades
  res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {}, sessionToken: slot.token, sessionRevision: 0 });
  assert.equal(res.status, 409, "revision moved on after the first upgrade");
  res = await post(origin, "/api/auth/passkey/authenticate/finish", headers,
    { challengeId: "ch-auth-1", response: {} });
  assert.equal(res.status, 422);
});

test("real service: unknown challenges and bogus responses answer 401, never 500", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f); // no injection: the real challenge store + verifiers
  const { slot, session } = signIn(f);
  const headers = authedHeaders(origin, slot, session);
  let res = await post(origin, "/api/auth/passkey/register/finish", headers, { challengeId: "nope", response: {} });
  assert.equal(res.status, 401);
  assert.equal(await errorCode(res), "invalid_passkey_challenge");
  // A real challenge is issued, then consumed by a bogus response: 401, single-use.
  const options = await (await post(origin, "/api/auth/passkey/register/options", headers, {})).json();
  res = await post(origin, "/api/auth/passkey/register/finish", headers,
    { challengeId: options.challengeId, response: { bogus: true } });
  assert.equal(res.status, 401);
  assert.equal(await errorCode(res), "passkey_verification_failed");
  res = await post(origin, "/api/auth/passkey/register/finish", headers,
    { challengeId: options.challengeId, response: { bogus: true } });
  assert.equal(res.status, 401, "challenge was consumed by the first attempt");
  res = await post(origin, "/api/auth/passkey/authenticate/finish",
    { ...jsonHeaders, Origin: origin },
    { challengeId: "nope", response: {}, sessionToken: "x".repeat(43), sessionRevision: 0 });
  assert.equal(res.status, 401);
});

test("https origins are accepted end to end", async t => {
  const f = createAcceptanceFixture();
  const service = fakePasskeyService();
  // Grab a free port first so the configured https origin matches the listener.
  const { createServer } = await import("node:http");
  const probe = createServer();
  await new Promise(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const origin = `https://127.0.0.1:${port}`;
  const server = createRoomServer({ store: f.store, origin, passkeyService: service });
  await new Promise(resolve => server.listen(port, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
    rmSync(f.directory, { recursive: true, force: true });
  });
  const res = await post(`http://127.0.0.1:${port}`, "/api/auth/passkey/authenticate/options",
    { ...jsonHeaders, Origin: origin }, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).rpId, "127.0.0.1");
});

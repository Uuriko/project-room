// HTTP integration tests for recovery codes (slice 6, RC-2026-09-17-015):
// the /api/auth/recovery-codes/{generate,redeem,status} routes in
// server/http.mjs, wired to store.accountLogins (slice 1). Codes are real
// one-time values minted against a disposable SQLite database; the server
// listens on loopback only — no external network, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RoomStore } from "../server/store.mjs";
import { initialRoom } from "../server/bootstrap.mjs";
import { createRoomServer } from "../server/http.mjs";

const EMAIL = "ada@example.com";
const CODE_PATTERN = /^[a-z0-9_-]{8}-[a-z0-9_-]{8}$/; // base64url pairs, lowercased (slice-1 model format)

function accountCookie(response) {
  const value = response.headers.get("set-cookie");
  assert.match(value, /^account_session=[A-Za-z0-9_-]{43};/);
  return value.split(";", 1)[0];
}

async function errorCode(response, status, code) {
  assert.equal(response.status, status);
  const body = await response.json();
  assert.equal(body.error.code, code);
  return body;
}

async function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), "project-room-recovery-codes-http-"));
  const store = new RoomStore(join(directory, "room.sqlite"));
  store.initialize(initialRoom());
  store.createAccount("acct-1");
  store.accountLogins.linkPasswordMethod("acct-1", { email: EMAIL, verifier: "scrypt$fixture-never-real" });
  const accountAccessKey = store.issueAccountAccessKey("acct-1");
  const server = createRoomServer({ store, streamInterval: 15 });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeStreams();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    store.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const request = (path, { method = "GET", data, headers = {} } = {}) => fetch(`${origin}${path}`, {
    method,
    headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    ...(data === undefined ? {} : { body: JSON.stringify(data) })
  });
  return { store, origin, request, accountAccessKey };
}

async function loginAccount(request, origin, accountAccessKey) {
  const bootstrapResponse = await request("/api/account-session");
  assert.equal(bootstrapResponse.status, 200);
  const cookie = accountCookie(bootstrapResponse);
  const bootstrap = await bootstrapResponse.json();
  const response = await request("/api/account-session", {
    method: "POST",
    headers: { Cookie: cookie, Origin: origin, "X-CSRF-Token": bootstrap.csrf },
    data: { accountAccessKey, expectedSessionRevision: bootstrap.sessionRevision }
  });
  assert.equal(response.status, 201);
  return { cookie, session: await response.json() };
}

async function anonymousSlot(request) {
  const response = await request("/api/account-session");
  assert.equal(response.status, 200);
  const cookie = accountCookie(response);
  return { cookie, slot: await response.json() };
}

const writeHeaders = (cookie, origin, csrf) => ({ Cookie: cookie, Origin: origin, "X-CSRF-Token": csrf });

test("generate requires an authenticated account session", async t => {
  const { request, origin } = await fixture(t);
  const { slot } = await anonymousSlot(request);
  const response = await request("/api/auth/recovery-codes/generate", {
    method: "POST",
    headers: writeHeaders("account_session=unused", origin, slot.csrf),
    data: {}
  });
  await errorCode(response, 401, "unauthenticated");
  const missing = await request("/api/auth/recovery-codes/generate", {
    method: "POST", headers: { Origin: origin }, data: {}
  });
  await errorCode(missing, 401, "unauthenticated");
});

test("generate returns 10 codes once, with a shown-once warning", async t => {
  const { store, request, origin, accountAccessKey } = await fixture(t);
  const { cookie, session } = await loginAccount(request, origin, accountAccessKey);
  const response = await request("/api/auth/recovery-codes/generate", {
    method: "POST",
    headers: writeHeaders(cookie, origin, session.csrf),
    data: {}
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.codes.length, 10);
  assert.equal(body.count, 10);
  assert.equal(new Set(body.codes).size, 10, "codes are unique");
  for (const code of body.codes) assert.match(code, CODE_PATTERN);
  assert.match(body.warning, /shown once/i);
  assert.match(body.warning, /single time/i);
  assert.match(body.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(store.accountLogins.recoveryCodesRemaining("acct-1"), 10);
});

test("redeem burns a code, records the method use, and upgrades the slot", async t => {
  const { store, request, origin } = await fixture(t);
  const { codes } = store.accountLogins.generateRecoveryCodes("acct-1");
  const { cookie, slot } = await anonymousSlot(request);
  const response = await request("/api/auth/recovery-codes/redeem", {
    method: "POST",
    headers: writeHeaders(cookie, origin, slot.csrf),
    data: { email: EMAIL, code: codes[0], sessionToken: cookie.split("=", 2)[1], sessionRevision: slot.sessionRevision }
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.remaining, 9);
  assert.equal(body.session.authenticated, true);
  assert.equal(body.session.account.id, "acct-1");
  const slotToken = cookie.split("=", 2)[1];
  const authenticated = store.authenticateAccountSession(slotToken);
  assert.equal(authenticated.account.id, "acct-1");
  const method = store.accountLogins.listMethods("acct-1").find(candidate => candidate.type === "recovery-code-set");
  assert.ok(method.lastUsedAt, "a successful redeem records the method use");
  // The same code is burned: a second redeem answers with the invalid shape.
  const retry = await anonymousSlot(request);
  await errorCode(await request("/api/auth/recovery-codes/redeem", {
    method: "POST",
    headers: writeHeaders(retry.cookie, origin, retry.slot.csrf),
    data: { email: EMAIL, code: codes[0], sessionToken: retry.cookie.split("=", 2)[1], sessionRevision: retry.slot.sessionRevision }
  }), 401, "invalid_recovery_code");
});

test("regenerating invalidates the previous set", async t => {
  const { store, request, origin, accountAccessKey } = await fixture(t);
  const { cookie, session } = await loginAccount(request, origin, accountAccessKey);
  const headers = writeHeaders(cookie, origin, session.csrf);
  const first = await (await request("/api/auth/recovery-codes/generate", { method: "POST", headers, data: {} })).json();
  const second = await (await request("/api/auth/recovery-codes/generate", { method: "POST", headers, data: {} })).json();
  assert.notDeepEqual(first.codes, second.codes);
  assert.equal(store.accountLogins.recoveryCodesRemaining("acct-1"), 10);
  const { cookie: slotCookie, slot } = await anonymousSlot(request);
  await errorCode(await request("/api/auth/recovery-codes/redeem", {
    method: "POST",
    headers: writeHeaders(slotCookie, origin, slot.csrf),
    data: { email: EMAIL, code: first.codes[0], sessionToken: slotCookie.split("=", 2)[1], sessionRevision: slot.sessionRevision }
  }), 401, "invalid_recovery_code");
});

test("redeem: unknown email and wrong code return the same 401 shape", async t => {
  const { store, request, origin } = await fixture(t);
  store.accountLogins.generateRecoveryCodes("acct-1");
  const unknown = await anonymousSlot(request);
  const unknownBody = await errorCode(await request("/api/auth/recovery-codes/redeem", {
    method: "POST",
    headers: writeHeaders(unknown.cookie, origin, unknown.slot.csrf),
    data: { email: "nobody@example.com", code: "deadbeef-deadbeef", sessionToken: unknown.cookie.split("=", 2)[1], sessionRevision: unknown.slot.sessionRevision }
  }), 401, "invalid_recovery_code");
  const wrong = await anonymousSlot(request);
  const wrongBody = await errorCode(await request("/api/auth/recovery-codes/redeem", {
    method: "POST",
    headers: writeHeaders(wrong.cookie, origin, wrong.slot.csrf),
    data: { email: " Ada@Example.com ", code: "deadbeef-deadbeef", sessionToken: wrong.cookie.split("=", 2)[1], sessionRevision: wrong.slot.sessionRevision }
  }), 401, "invalid_recovery_code");
  assert.equal(unknownBody.error.status, wrongBody.error.status);
  assert.equal(unknownBody.error.code, wrongBody.error.code);
  assert.equal(unknownBody.error.message, wrongBody.error.message);
});

test("redeem trips the per-email rate limit", async t => {
  const { store, request, origin } = await fixture(t);
  store.accountLogins.generateRecoveryCodes("acct-1");
  let last;
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const { cookie, slot } = await anonymousSlot(request);
    last = await request("/api/auth/recovery-codes/redeem", {
      method: "POST",
      headers: writeHeaders(cookie, origin, slot.csrf),
      data: { email: EMAIL, code: "deadbeef-deadbeef", sessionToken: cookie.split("=", 2)[1], sessionRevision: slot.sessionRevision }
    });
  }
  await errorCode(last, 429, "rate_limited");
});

test("status reflects configured and remaining, never the codes", async t => {
  const { store, request, origin, accountAccessKey } = await fixture(t);
  await errorCode(await request("/api/auth/recovery-codes/status"), 401, "unauthenticated");
  const { cookie, session } = await loginAccount(request, origin, accountAccessKey);
  const headers = { Cookie: cookie };
  const before = await (await request("/api/auth/recovery-codes/status", { headers })).json();
  assert.deepEqual(before, { configured: false, remaining: null });
  const generated = await request("/api/auth/recovery-codes/generate", {
    method: "POST",
    headers: writeHeaders(cookie, origin, session.csrf),
    data: {}
  });
  assert.equal(generated.status, 200);
  const after = await (await request("/api/auth/recovery-codes/status", { headers })).json();
  assert.deepEqual(after, { configured: true, remaining: 10 });
  store.accountLogins.consumeRecoveryCode("acct-1", (await generated.json()).codes[0]);
  const burned = await (await request("/api/auth/recovery-codes/status", { headers })).json();
  assert.deepEqual(burned, { configured: true, remaining: 9 });
  assert.ok(!("codes" in burned), "status never exposes codes");
});

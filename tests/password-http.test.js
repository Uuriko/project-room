// HTTP integration tests for the email+password routes in server/http.mjs:
// POST /api/auth/password/signup, /api/auth/password/login and
// /api/auth/password/change (slice 2, RC-2026-09-17-011). Boots a real
// server against an acceptance-fixture store over loopback; no network calls,
// no real credentials, all emails and passwords are synthetic fixtures.
import test from "node:test";
import { request as httpRequest } from "node:http";
import { hashPassword, verifyPassword } from "../src/password-auth.mjs";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

async function startServer(t) {
  const f = createAcceptanceFixture();
  const server = createRoomServer({ store: f.store });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => {
    server.closeStreams(); server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    f.store.close();
  });
  const origin = `http://127.0.0.1:${server.address().port}`;
  return { f, origin };
}

const post = (origin, path, data, cookie = null) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, ...(cookie ? { Cookie: cookie } : {}) },
  body: JSON.stringify(data)
});

const freshSlot = f => {
  const slot = f.store.createAccountSessionSlot();
  return { sessionToken: slot.token, sessionRevision: slot.session.sessionRevision };
};

const email = n => `slice2-fixture-${n}@example.invalid`;
const password = n => `fixture-password-${n}-long-enough`;

const accountCookie = res => {
  const match = /account_session=([A-Za-z0-9_-]{43})/.exec(res.headers.get("set-cookie") || "");
  return match?.[1] ?? null;
};

// Service errors serialize as { error: { code, message }, ... }.
const errBody = async res => (await res.json()).error;

async function signup(t, n, overrides = {}) {
  const { f, origin } = await startServer(t);
  const slot = freshSlot(f);
  const res = await post(origin, "/api/auth/password/signup",
    { email: email(n), password: password(n), ...slot, ...overrides });
  return { f, origin, res, slot };
}

test("signup provisions an unverified email account and upgrades the slot", async t => {
  const { f, res, slot } = await signup(t, 1);
  assert.equal(res.status, 202);
  const body = await res.json();
  assert.equal(body.status, "check_email");
  assert.equal(typeof body.mailConfigured, "boolean");
  const fresh = accountCookie(res);
  assert.ok(fresh && fresh !== slot.sessionToken, "signup rotates the slot token");
  assert.throws(() => f.store.authenticateAccountSession(slot.sessionToken), { code: "unauthenticated" });
  const session = f.store.authenticateAccountSession(fresh);
  assert.match(session.account.id, /^email:[0-9a-f]{64}$/);
  const row = f.store.db.prepare("SELECT id, origin FROM accounts WHERE id=?").get(session.account.id);
  assert.equal(row.origin, "password-signup");
  const methods = f.store.accountLogins.listMethods(session.account.id);
  assert.deepEqual(methods.map(m => m.type), ["password"]);
  assert.equal(methods[0].email, email(1));
  assert.equal(methods[0].verifiedAt, null);
  assert.equal(f.store.accountLogins.findAccountByVerifiedEmail(email(1)), null);
  assert.ok(methods[0].lastUsedAt, "signup touches the password method");
  assert.equal(JSON.stringify(body).includes(password(1)), false, "no plaintext password in the response");
});

test("signup answers the same status and body shape for a new and an existing email", async t => {
  const { f, origin } = await startServer(t);
  const first = freshSlot(f);
  const ok = await post(origin, "/api/auth/password/signup", { email: email(2), password: password(2), ...first });
  assert.equal(ok.status, 202);
  const created = await ok.json();
  const second = freshSlot(f);
  const dup = await post(origin, "/api/auth/password/signup", { email: email(2), password: password(2), ...second });
  assert.equal(dup.status, 202);
  const again = await dup.json();
  assert.deepEqual(
    { status: again.status, mailConfigured: again.mailConfigured, keys: Object.keys(again).sort() },
    { status: created.status, mailConfigured: created.mailConfigured, keys: Object.keys(created).sort() }
  );
  assert.equal(accountCookie(dup), null);
  const third = freshSlot(f);
  const dupCase = await post(origin, "/api/auth/password/signup", { email: email(2).toUpperCase(), password: password(2), ...third });
  assert.equal(dupCase.status, 202);
  const cased = await dupCase.json();
  assert.equal(cased.status, created.status);
  assert.equal(cased.mailConfigured, created.mailConfigured);
});

test("signup validates email and password policy with 422s", async t => {
  const { f, origin } = await startServer(t);
  const badEmail = await post(origin, "/api/auth/password/signup", { email: "not-an-email", password: password(3), ...freshSlot(f) });
  assert.equal(badEmail.status, 422);
  assert.equal((await errBody(badEmail)).code, "invalid_email");
  const short = await post(origin, "/api/auth/password/signup", { email: email(3), password: "short", ...freshSlot(f) });
  assert.equal(short.status, 422);
  assert.equal((await errBody(short)).code, "password_too_short");
  const missing = await post(origin, "/api/auth/password/signup", { email: email(3), ...freshSlot(f) });
  assert.equal(missing.status, 422);
  assert.equal((await errBody(missing)).code, "invalid_signup");
});

test("signup then login roundtrip upgrades a real slot", async t => {
  const { f, origin } = await startServer(t);
  const first = freshSlot(f);
  const created = await post(origin, "/api/auth/password/signup", { email: email(4), password: password(4), ...first });
  assert.equal(created.status, 202);
  const createdSession = f.store.authenticateAccountSession(accountCookie(created));
  const second = freshSlot(f);
  const logged = await post(origin, "/api/auth/password/login", { email: email(4), password: password(4), ...second });
  assert.equal(logged.status, 200);
  const body = await logged.json();
  assert.equal(body.authenticated, true);
  assert.equal(body.account.id, createdSession.account.id, "login lands on the signed-up account");
  // QAS-702: login mints a fresh slot token — the presented token is retired.
  const fresh = accountCookie(logged);
  assert.ok(fresh && fresh !== second.sessionToken, "login rotates the slot token");
  assert.throws(() => f.store.authenticateAccountSession(second.sessionToken), { code: "unauthenticated" });
  const session = f.store.authenticateAccountSession(fresh);
  assert.equal(session.account.id, createdSession.account.id);
});

test("wrong password is 401 invalid_credentials", async t => {
  const { f, origin } = await startServer(t);
  const slot = freshSlot(f);
  await post(origin, "/api/auth/password/signup", { email: email(5), password: password(5), ...slot });
  const res = await post(origin, "/api/auth/password/login", { email: email(5), password: "definitely-the-wrong-password", ...freshSlot(f) });
  assert.equal(res.status, 401);
  assert.equal((await errBody(res)).code, "invalid_credentials");
});

test("unknown email answers 401 with the same shape as a wrong password", async t => {
  const { f, origin } = await startServer(t);
  const slot = freshSlot(f);
  await post(origin, "/api/auth/password/signup", { email: email(6), password: password(6), ...slot });
  const wrong = await post(origin, "/api/auth/password/login", { email: email(6), password: "wrong-password-here", ...freshSlot(f) });
  const unknown = await post(origin, "/api/auth/password/login", { email: "nobody-here@example.invalid", password: "wrong-password-here", ...freshSlot(f) });
  assert.equal(wrong.status, 401);
  assert.equal(unknown.status, 401);
  const wrongBody = await wrong.json(), unknownBody = await unknown.json();
  assert.equal(wrongBody.error.code, "invalid_credentials");
  assert.equal(unknownBody.error.code, "invalid_credentials");
  assert.deepEqual(Object.keys(unknownBody).sort(), Object.keys(wrongBody).sort(), "response shapes match");
  assert.equal(unknownBody.error.message, wrongBody.error.message, "messages match: existence is never revealed");
});

test("an account with no password verifier still answers 401 like an unknown email", async t => {
  const { f, origin } = await startServer(t);
  // Magic-link-only account (slice 3 territory): provisioned directly through
  // the slice-1 model so no password verifier exists.
  const normalized = email(7);
  const { createHash } = await import("node:crypto");
  const id = `email:${createHash("sha256").update(normalized).digest("hex")}`;
  f.store.createAccount(id, "password-signup");
  f.store.accountLogins.linkMagicMethod(id, { email: normalized });
  const res = await post(origin, "/api/auth/password/login", { email: normalized, password: password(7), ...freshSlot(f) });
  assert.equal(res.status, 401);
  assert.equal((await errBody(res)).code, "invalid_credentials");
});

test("per-email rate limit trips after 10 login attempts", async t => {
  const { f, origin } = await startServer(t);
  const slot = freshSlot(f);
  await post(origin, "/api/auth/password/signup", { email: email(8), password: password(8), ...slot });
  let last;
  for (let i = 0; i < 11; i++) {
    last = await post(origin, "/api/auth/password/login", { email: email(8), password: "wrong-password-here", ...freshSlot(f) });
    if (i < 10) assert.equal(last.status, 401, `attempt ${i + 1} is still a credential failure`);
  }
  assert.equal(last.status, 429, "the 11th attempt trips the per-email limiter");
  assert.equal((await errBody(last)).code, "rate_limited");
  // A different email still has its own budget.
  const other = await post(origin, "/api/auth/password/login", { email: "someone-else@example.invalid", password: "wrong-password-here", ...freshSlot(f) });
  assert.equal(other.status, 401);
});

test("change-password flow works and the old password stops working", async t => {
  const { f, origin } = await startServer(t);
  const slot = freshSlot(f);
  const created = await post(origin, "/api/auth/password/signup", { email: email(9), password: password(9), ...slot });
  assert.equal(created.status, 202);
  const cookie = `account_session=${accountCookie(created)}`;
  const changed = await post(origin, "/api/auth/password/change",
    { currentPassword: password(9), newPassword: "brand-new-password-99" }, cookie);
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { status: "ok" });
  const oldLogin = await post(origin, "/api/auth/password/login", { email: email(9), password: password(9), ...freshSlot(f) });
  assert.equal(oldLogin.status, 401, "the old password no longer works");
  const newLogin = await post(origin, "/api/auth/password/login", { email: email(9), password: "brand-new-password-99", ...freshSlot(f) });
  assert.equal(newLogin.status, 200, "the new password works");
});

test("change-password rejects a wrong current password with 401", async t => {
  const { f, origin } = await startServer(t);
  const slot = freshSlot(f);
  const created = await post(origin, "/api/auth/password/signup", { email: email(10), password: password(10), ...slot });
  assert.equal(created.status, 202);
  const cookie = `account_session=${accountCookie(created)}`;
  const bad = await post(origin, "/api/auth/password/change",
    { currentPassword: "not-the-current-password", newPassword: "brand-new-password-99" }, cookie);
  assert.equal(bad.status, 401);
  assert.equal((await errBody(bad)).code, "invalid_credentials");
  // The original password still works afterwards.
  const still = await post(origin, "/api/auth/password/login", { email: email(10), password: password(10), ...freshSlot(f) });
  assert.equal(still.status, 200);
});

test("change-password requires an authenticated session and policy-checks the new password", async t => {
  const { f, origin } = await startServer(t);
  const unauth = await post(origin, "/api/auth/password/change", { currentPassword: "x", newPassword: password(11) });
  assert.equal(unauth.status, 401);
  const slot = freshSlot(f);
  const created = await post(origin, "/api/auth/password/signup", { email: email(11), password: password(11), ...slot });
  const cookie = `account_session=${accountCookie(created)}`;
  const weak = await post(origin, "/api/auth/password/change", { currentPassword: password(11), newPassword: "short" }, cookie);
  assert.equal(weak.status, 422);
  assert.equal((await errBody(weak)).code, "password_too_short");
});

for (const mutation of ["logout", "rotate login slot"]) {
  test(`held password-change body refuses concurrent ${mutation}`, { timeout: 5000 }, async t => {
    const { f, origin, res } = await signup(t, 30);
    const token = accountCookie(res), view = f.store.authenticateAccountSession(token), cookie = `account_session=${token}`;
    const payload = JSON.stringify({ currentPassword: password(30), newPassword: "replacement-password-long-enough" });
    const original = f.store.authenticateAccountSession.bind(f.store);
    let sawRead; const read = new Promise(resolve => { sawRead = resolve; }); let armed = true;
    f.store.authenticateAccountSession = (...args) => {
      const value = original(...args);
      if (armed && args[0] === token) { armed = false; sawRead(); }
      return value;
    };
    let held;
    const result = new Promise((resolve, reject) => {
      held = httpRequest(origin + "/api/auth/password/change", { method: "POST", headers: {
        Origin: origin, "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload), Cookie: cookie
      } }, response => { response.resume(); response.on("end", () => resolve(response.statusCode)); });
      held.on("error", reject); held.write(payload.slice(0, 1));
    });
    t.after(() => held.destroy()); await read;
    if (mutation === "logout") {
      const logout = await fetch(origin + "/api/account-session", { method: "DELETE", headers: {
        Origin: origin, "Content-Type": "application/json", Cookie: cookie, "X-CSRF-Token": view.csrf
      }, body: JSON.stringify({ expectedSessionRevision: view.sessionRevision }) });
      assert.equal(logout.status, 200);
    } else {
      const rotated = await post(origin, "/api/auth/password/login", {
        email: email(30), password: password(30), sessionToken: token, sessionRevision: view.sessionRevision
      }, cookie);
      assert.equal(rotated.status, 200); assert.notEqual(accountCookie(rotated), token);
    }
    held.end(payload.slice(1));
    const status = await result;
    assert.ok([401, 409].includes(status), `stale password change must be refused, got ${status}`);
    const oldLogin = await post(origin, "/api/auth/password/login", { email: email(30), password: password(30), ...freshSlot(f) });
    assert.equal(oldLogin.status, 200, "password remains unchanged and a fresh slot can sign in");
  });
}

test("password-change cannot overwrite a verifier changed before its writer transaction", async t => {
  const { f, origin, res } = await signup(t, 31);
  const token = accountCookie(res);
  const accountId = f.store.authenticateAccountSession(token).account.id;
  const concurrentPassword = "concurrent-replacement-password";
  const concurrentVerifier = hashPassword(concurrentPassword);
  const original = f.store.transaction.bind(f.store); let armed = true;
  // Simulate another writer committing after proof/hash work, before this writer obtains its transaction.
  f.store.transaction = fn => {
    if (armed) { armed = false; f.store.accountLogins.setPasswordVerifier(accountId, concurrentVerifier); }
    return original(fn);
  };
  const response = await post(origin, "/api/auth/password/change", {
    currentPassword: password(31), newPassword: "stale-request-password-long-enough"
  }, `account_session=${token}`);
  assert.equal(response.status, 409);
  assert.equal((await errBody(response)).code, "password_changed");
  assert.equal(verifyPassword(concurrentPassword, f.store.accountLogins.readPasswordVerifier(accountId)), true);
  assert.equal(verifyPassword("stale-request-password-long-enough", f.store.accountLogins.readPasswordVerifier(accountId)), false);
});

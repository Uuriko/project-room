import test from "node:test";
import assert from "node:assert/strict";
import { ACCOUNT_SESSION_ROUTES } from "../server/routes/account-sessions.mjs";

const route = method => ACCOUNT_SESSION_ROUTES.find(row => row.method === method);
function fixture({ token = "saved-session", authError = false, csrfError = false, revoked = 1 } = {}) {
  const calls = [], auth = { account: { id: "owner-account" }, credentialHash: "current-slot" };
  const reject = (status, code) => { throw Object.assign(new Error(code), { status, code }); };
  const methods = {
    authenticateAccountSession(value, room, binding) {
      calls.push(["authenticate", value, room, binding]);
      if (authError) reject(401, "unauthenticated");
      return auth;
    },
    listAccountSessions(account, current) { calls.push(["list", account, current]); return [{ id: "public-slot" }]; },
    revokeAccountSession(account, id) { calls.push(["revoke", account, id]); return revoked; }
  };
  const store = new Proxy(methods, { get(target, key) {
    assert.ok(Object.hasOwn(target, key), `unexpected store method ${String(key)}`); return target[key];
  } });
  const ctx = {
    req: {}, res: {}, store, params: { id: "public-slot" }, accountCookieName: "account_session",
    cookie: (_req, name) => { assert.equal(name, "account_session"); return token; },
    accountBinding: () => "session-binding", remoteAddress: "127.0.0.1", reject,
    rate: (key, max) => { assert.equal(max, 60); calls.push(["rate", key]); },
    protectWrite: (_req, value, required) => {
      assert.equal(value, auth); assert.equal(required, false); calls.push(["csrf"]);
      if (csrfError) reject(403, "csrf_denied");
    },
    json: (_res, status, body) => ({ status, body })
  };
  return { ctx, calls };
}

test("account session routes refuse anonymous and revoked callers before inventory or mutation", async () => {
  for (const method of ["GET", "DELETE"]) for (const options of [{ token: null }, { authError: true }]) {
    const f = fixture(options);
    await assert.rejects(route(method).handler(f.ctx), { status: 401, code: "account_session_required" });
    assert.equal(f.calls.some(call => ["list", "revoke"].includes(call[0])), false);
    // Wrong-method dispatch uses this same authentication hook before 405.
    assert.throws(() => route(method).authenticate(f.ctx), { status: 401, code: "account_session_required" });
  }
});

test("inventory uses authenticated account and current slot, never caller-selected account", async () => {
  const f = fixture(); f.ctx.params.accountId = "other-account";
  assert.deepEqual(await route("GET").handler(f.ctx), { status: 200, body: { sessions: [{ id: "public-slot" }] } });
  assert.deepEqual(f.calls.find(call => call[0] === "authenticate"), ["authenticate", "saved-session", null, "session-binding"]);
  assert.deepEqual(f.calls.find(call => call[0] === "list"), ["list", "owner-account", "current-slot"]);
});

test("targeted revoke enforces CSRF before effects and maps missing targets to uniform 404", async () => {
  const denied = fixture({ csrfError: true });
  await assert.rejects(route("DELETE").handler(denied.ctx), { status: 403, code: "csrf_denied" });
  assert.equal(denied.calls.some(call => call[0] === "revoke"), false);
  const missing = fixture({ revoked: 0 });
  await assert.rejects(route("DELETE").handler(missing.ctx), { status: 404, code: "session_not_found" });
  const allowed = fixture();
  assert.deepEqual(await route("DELETE").handler(allowed.ctx), { status: 200, body: { revoked: 1 } });
  assert.deepEqual(allowed.calls.filter(call => ["csrf", "revoke"].includes(call[0])), [["csrf"], ["revoke", "owner-account", "public-slot"]]);
});

// RC-2026-09-19-078 — HTTP integration tests for the account-management
// surface in server/http.mjs: account-level profile endpoints (display
// name / avatar), the first-run onboarding step for new accounts, the
// deletion retention policy, and confirm-then-delete account deletion
// wired to src/account-deletion.mjs via server/account-deletion.mjs.
// Boots a real server against an acceptance-fixture store over loopback.

import test from "node:test";
import assert from "node:assert/strict";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";

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
const get = (origin, path, creds = null) => {
  const cookie = typeof creds === "string" ? creds : creds?.cookie;
  return fetch(origin + path, { headers: cookie ? { Cookie: cookie } : {} });
};
// Authenticated POST for the account mutations: cookie slot + CSRF header.
const authedPost = (origin, path, data, creds) => fetch(origin + path, {
  method: "POST",
  headers: { "Content-Type": "application/json", Origin: origin, Cookie: creds.cookie, "X-CSRF-Token": creds.csrf },
  body: JSON.stringify(data)
});

const password = n => `fixture-password-${n}-long-enough`;

// A brand-new account via the real signup route: it starts un-onboarded.
async function passwordAccount(t, n) {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const email = `acctmgmt-${n}@example.invalid`;
  const slot = f.store.createAccountSessionSlot();
  const res = await post(origin, "/api/auth/password/signup",
    { email, password: password(n), sessionToken: slot.token, sessionRevision: slot.session.sessionRevision });
  assert.equal(res.status, 201);
  const body = await res.json();
  return { f, origin, accountId: body.account.id, email,
    creds: { cookie: `account_session=${slot.token}`, csrf: f.store.accountSessionSlot(slot.token).csrf } };
}

const errBody = async res => (await res.json()).error;

test("GET /api/account/profile requires an authenticated session", async t => {
  const { origin } = await passwordAccount(t, 1);
  assert.equal((await get(origin, "/api/account/profile")).status, 401);
  const anon = createAcceptanceFixture().store.createAccountSessionSlot();
  assert.equal((await get(origin, "/api/account/profile", `account_session=${anon.token}`)).status, 401);
});

test("profile update persists display name and avatar", async t => {
  const { f, origin, accountId, creds } = await passwordAccount(t, 2);

  let res = await get(origin, "/api/account/profile", creds.cookie);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { id: accountId, displayName: null, avatarUrl: null, onboardingComplete: false });

  res = await authedPost(origin, "/api/account/profile",
    { displayName: "  Ada Lovelace  ", avatarUrl: "https://example.invalid/avatars/ada.png" }, creds);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(),
    { id: accountId, displayName: "Ada Lovelace", avatarUrl: "https://example.invalid/avatars/ada.png", onboardingComplete: false });

  // The update persisted: a fresh read sees it.
  res = await get(origin, "/api/account/profile", creds.cookie);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).displayName, "Ada Lovelace");

  // The store agrees, independent of HTTP.
  assert.equal(f.store.accountProfile(accountId).avatarUrl, "https://example.invalid/avatars/ada.png");

  // Empty avatar string clears it.
  res = await authedPost(origin, "/api/account/profile", { avatarUrl: "" }, creds);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).avatarUrl, null);
});

test("profile update validates input", async t => {
  const { origin, creds } = await passwordAccount(t, 3);
  const bad = async (data, code) => {
    const res = await authedPost(origin, "/api/account/profile", data, creds);
    assert.equal(res.status, 422);
    assert.equal((await errBody(res)).code, code);
  };
  await bad({ displayName: "   " }, "invalid_profile");
  await bad({ displayName: "x".repeat(65) }, "invalid_profile");
  await bad({ displayName: 42 }, "invalid_profile");
  await bad({ avatarUrl: "http://example.invalid/a.png" }, "invalid_profile");
  await bad({ avatarUrl: "not a url" }, "invalid_profile");
  await bad({ avatarUrl: 42 }, "invalid_profile");
  await bad({ nickname: "Ada" }, "invalid_profile");
  await bad({}, "invalid_profile");
  // Partial update is fine: displayName alone.
  const res = await authedPost(origin, "/api/account/profile", { displayName: "Ada" }, creds);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).displayName, "Ada");
  // Mutations without the CSRF token are rejected.
  const noCsrf = await post(origin, "/api/account/profile", { displayName: "Eve" }, creds.cookie);
  assert.equal(noCsrf.status, 403);
  assert.equal((await errBody(noCsrf)).code, "csrf_denied");
});

test("new accounts land on onboarding until they complete it", async t => {
  const { origin, accountId, creds } = await passwordAccount(t, 4);

  let res = await get(origin, "/api/account/onboarding", creds.cookie);
  assert.equal(res.status, 200);
  let state = await res.json();
  assert.equal(state.accountId, accountId);
  assert.equal(state.completed, false);
  const profile = state.steps.find(s => s.id === "set-profile");
  assert.ok(profile, "the set-profile step exists");
  assert.equal(profile.done, false);

  // Setting a display name completes the profile step but not onboarding.
  await authedPost(origin, "/api/account/profile", { displayName: "Ada" }, creds);
  state = await (await get(origin, "/api/account/onboarding", creds.cookie)).json();
  assert.equal(state.steps.find(s => s.id === "set-profile").done, true);
  assert.equal(state.completed, false);

  // Completing onboarding sticks.
  res = await authedPost(origin, "/api/account/onboarding/complete", {}, creds);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).completed, true);
  state = await (await get(origin, "/api/account/onboarding", creds.cookie)).json();
  assert.equal(state.completed, true);
  assert.equal((await get(origin, "/api/account/onboarding")).status, 401);
});

test("GET /api/account/retention documents what deletion purges and retains", async t => {
  const { origin, creds } = await passwordAccount(t, 5);
  assert.equal((await get(origin, "/api/account/retention")).status, 401);
  const res = await get(origin, "/api/account/retention", creds.cookie);
  assert.equal(res.status, 200);
  const policy = (await res.json()).policy;
  assert.equal(typeof policy.version, "string");
  assert.ok(policy.purged.some(p => p.category === "login_methods"), "login methods are purged");
  assert.ok(policy.purged.some(p => p.category === "sessions"), "sessions are purged");
  const audit = policy.retained.find(r => r.category === "audit");
  assert.ok(audit && audit.reason.length > 0, "audit retention carries a reason");
});

test("deletion is confirm-then-delete: plan first, then token-bound delete", async t => {
  const { origin, creds } = await passwordAccount(t, 6);
  assert.equal((await get(origin, "/api/account/deletion/plan")).status, 401);

  const planRes = await get(origin, "/api/account/deletion/plan", creds.cookie);
  assert.equal(planRes.status, 200);
  const planned = await planRes.json();
  assert.ok(planned.plan && Array.isArray(planned.plan.steps), "plan carries purge steps");
  assert.equal(planned.plan.accountId !== null, true);
  assert.ok(typeof planned.summary.text === "string" && planned.summary.text.includes("Account deletion"), "confirmation summary present");
  assert.deepEqual(planned.summary.purgeOrder[planned.summary.purgeOrder.length - 1], "profile", "profile purges last");
  assert.ok(typeof planned.confirmationToken === "string" && planned.confirmationToken.length > 0);
  assert.ok(planned.retention && planned.retention.version, "retention policy attached");

  // No token: 422. Garbage token: 401.
  let res = await authedPost(origin, "/api/account/delete", {}, creds);
  assert.equal(res.status, 422);
  assert.equal((await errBody(res)).code, "invalid_deletion");
  res = await authedPost(origin, "/api/account/delete", { confirmationToken: "bogus.token" }, creds);
  assert.equal(res.status, 401);
  assert.equal((await errBody(res)).code, "invalid_confirmation");
});

test("deletion actually removes the account's data", async t => {
  const { f, origin, accountId, creds } = await passwordAccount(t, 7);
  // Give the account a display name, an extra session, and a room-free
  // second credential so the purge has something to remove.
  await authedPost(origin, "/api/account/profile", { displayName: "Doomed Ada" }, creds);
  const extraSlot = f.store.createAccountSessionSlot();
  f.store.loginAccountSessionWithMethod(extraSlot.token, accountId, extraSlot.session.sessionRevision,
    { method: { kind: "magic", ref: "fixture" } });

  const planned = await (await get(origin, "/api/account/deletion/plan", creds.cookie)).json();
  const res = await authedPost(origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, creds);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.deleted, true);
  assert.equal(body.accountId, accountId);
  assert.ok(body.receipt.purged.some(p => p.category === "login_methods" && p.removed > 0), "login methods were removed");
  assert.ok(body.receipt.purged.some(p => p.category === "sessions" && p.removed > 0), "sessions were removed");
  assert.ok(body.receipt.retained.some(r => r.category === "audit"), "audit rows reported retained");

  // Data is gone.
  const tableCount = table => f.store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE account_id=?`).get(accountId).n;
  assert.equal(tableCount("account_login_methods"), 0, "login methods purged");
  assert.equal(tableCount("account_magic_codes"), 0, "magic codes purged");
  assert.equal(tableCount("account_recovery_codes"), 0, "recovery codes purged");
  assert.equal(tableCount("account_passkey_credentials"), 0, "passkeys purged");
  assert.equal(tableCount("account_session_slots"), 0, "session slots purged");
  assert.equal(tableCount("account_credentials"), 0, "access keys purged");
  assert.equal(tableCount("member_accounts"), 0, "memberships purged");
  assert.equal(f.store.account(accountId).active, false, "account deactivated");
  assert.equal(f.store.accountProfile(accountId).displayName, null, "profile scrubbed");

  // The old session no longer authenticates, and the cookie was cleared.
  assert.equal((await get(origin, "/api/auth/methods", creds.cookie)).status, 401);
  const setCookie = res.headers.get("set-cookie") || "";
  assert.match(setCookie, /Max-Age=0/, "account cookie cleared");

  // A second delete with the same token is a 401: the account is gone.
  const again = await authedPost(origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, creds);
  assert.equal(again.status, 401);
});

test("deletion token is bound to the confirmed plan: changed data 409s", async t => {
  const { f, origin, accountId, creds } = await passwordAccount(t, 8);
  const planned = await (await get(origin, "/api/account/deletion/plan", creds.cookie)).json();

  // Data changes after confirmation: a new linked method invalidates the token.
  f.store.accountLogins.linkMagicMethod(accountId, { email: "extra-acctmgmt@example.invalid" });
  let res = await authedPost(origin, "/api/account/delete", { confirmationToken: planned.confirmationToken }, creds);
  assert.equal(res.status, 409);
  assert.equal((await errBody(res)).code, "plan_changed");
  assert.equal(f.store.account(accountId).active, true, "nothing was deleted");

  // A fresh plan + token deletes cleanly.
  const replanned = await (await get(origin, "/api/account/deletion/plan", creds.cookie)).json();
  res = await authedPost(origin, "/api/account/delete", { confirmationToken: replanned.confirmationToken }, creds);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).deleted, true);
});

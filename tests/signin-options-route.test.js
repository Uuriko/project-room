// Direct unit coverage for the sign-in options route group (H3, #3341).
// The HTTP-level contract (status, 405, no account fields) is pinned in
// tests/magic-links-http.test.js; this file pins the handler's probe
// semantics — including that a throwing provider probe reads as
// "not configured", never as an error — and the row's table shape. It
// also satisfies the untested-server-module gate
// (scripts/untested-modules-lint.mjs) for the new module.
import test from "node:test";
import assert from "node:assert/strict";
import { SIGNIN_OPTIONS_ROUTES, handleSigninOptions } from "../server/routes/signin-options.mjs";

function ctxFor({ mail = true, github = () => ({}), google = () => null, origin = "https://room.example", store } = {}) {
  const calls = [];
  return {
    calls,
    res: {},
    json: (res, status, value) => { calls.push({ status, value }); return value; },
    magicMailer: { isConfigured: () => mail },
    expectedOrigin: () => origin,
    githubClient: github,
    googleClient: google,
    store,
  };
}

test("the route row is a public GET in the table", () => {
  assert.equal(SIGNIN_OPTIONS_ROUTES.length, 1);
  const [row] = SIGNIN_OPTIONS_ROUTES;
  assert.equal(row.method, "GET");
  assert.equal(row.path, "/api/auth/signin-options");
  assert.equal(row.auth, "none");
  assert.equal(row.handler, handleSigninOptions);
});

test("the feed reports each provider's configuration honestly", async () => {
  const ctx = ctxFor({ mail: false, github: () => ({ clientId: "x" }), google: () => null });
  await handleSigninOptions(ctx);
  assert.equal(ctx.calls.length, 1);
  assert.equal(ctx.calls[0].status, 200);
  const { providers } = ctx.calls[0].value;
  assert.deepEqual(providers.github, { configured: true, verified: false });
  assert.deepEqual(providers.google, { configured: false });
  assert.deepEqual(providers.mail, { configured: false });
  assert.equal(typeof providers.passkey.configured, "boolean");
  // Nothing account-shaped leaks into the public feed.
  assert.deepEqual(Object.keys(ctx.calls[0].value), ["providers"]);
});

test("a throwing provider probe reads as not configured, never an error", async () => {
  const ctx = ctxFor({
    github: () => { throw new Error("provider blew up"); },
    google: () => { throw new Error("provider blew up"); },
  });
  await handleSigninOptions(ctx);
  const { providers } = ctx.calls[0].value;
  assert.deepEqual(providers.github, { configured: false, verified: false });
  assert.deepEqual(providers.google, { configured: false });
  assert.deepEqual(providers.mail, { configured: true });
});

test("GitHub reads verified only when a used OAuth login method is on record (#3548)", async () => {
  // A GitHub login method with last_used_at set exists solely because a
  // real sign-in completed against this deployment's secrets — that row
  // is what flips the wall's GitHub door from hidden to shown.
  const usedStore = { db: { prepare: () => ({ get: () => ({ 1: 1 }) }) } };
  const ctx = ctxFor({ store: usedStore });
  await handleSigninOptions(ctx);
  assert.deepEqual(ctx.calls[0].value.providers.github, { configured: true, verified: true });
  // A store that cannot answer reads as unverified, never as an error:
  // the gate fails closed.
  const brokenStore = { db: { prepare: () => { throw new Error("no db"); } } };
  const ctx2 = ctxFor({ store: brokenStore });
  await handleSigninOptions(ctx2);
  assert.deepEqual(ctx2.calls[0].value.providers.github, { configured: true, verified: false });
});

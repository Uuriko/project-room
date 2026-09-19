// HTTP integration tests for GitHub sign-in (slice 4, RC-2026-09-17-013):
// the /api/auth/github/start and /api/auth/github/callback routes in
// server/http.mjs, wired to server/github-oauth.mjs with no Clerk and no
// provider onboarding. GitHub's token, user and emails endpoints are
// mocked; no network calls, no real credentials.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAcceptanceFixture } from "../scripts/acceptance-fixture.mjs";
import { createRoomServer } from "../server/http.mjs";
import { GITHUB_START_PATH, GITHUB_CALLBACK_PATH, GITHUB_SCOPES, codeChallengeFor } from "../server/github-oauth.mjs";

const clientId = "Iv1.fixtureclientid0000";
const clientSecret = "fixture-secret-never-real";
const userId = 424242;
const verifiedEmail = "gh-user@example.com";

// Stub GitHub: token exchange, /user and /user/emails. The `code` sent to
// the token endpoint selects the scenario: "pkce-fixture" simulates a
// provider rejection of the grant (e.g. a PKCE/code mismatch).
function githubFetch({ id = userId, emails } = {}) {
  const captured = {};
  const fetchFn = async (url, init) => {
    if (url === "https://github.com/login/oauth/access_token") {
      assert.equal(init.method, "POST");
      assert.equal(init.headers.Accept, "application/json");
      const body = new URLSearchParams(init.body);
      captured.codeVerifier = body.get("code_verifier");
      if (body.get("code") === "pkce-fixture") {
        return new Response(JSON.stringify({ error: "incorrect_code_verifier" }),
          { status: 400, headers: { "content-type": "application/json" } });
      }
      return Response.json({ access_token: "gho_fixturetoken", token_type: "bearer", scope: GITHUB_SCOPES });
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
  fetchFn.captured = captured;
  return fetchFn;
}

function githubAuth(fetchFn = githubFetch()) {
  return { clientId, clientSecret, fetchImpl: fetchFn };
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

const accountCookie = res => {
  const setCookie = res.headers.get("set-cookie") || "";
  const match = /account_session=([A-Za-z0-9_-]{43})/.exec(setCookie);
  return match?.[1] ?? null;
};

const noSecrets = body => {
  const text = JSON.stringify(body);
  assert.equal(text.includes(clientSecret), false);
  assert.equal(text.includes("gho_fixturetoken"), false);
};

// Begin a flow against a fresh anonymous slot; returns the authorize URL.
async function beginFlow(origin, slotToken) {
  const start = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=${slotToken}`, { redirect: "manual" });
  assert.equal(start.status, 302);
  const authorize = new URL(start.headers.get("location"));
  assert.equal(authorize.origin, "https://github.com");
  assert.equal(authorize.pathname, "/login/oauth/authorize");
  assert.equal(authorize.searchParams.get("client_id"), clientId);
  assert.equal(authorize.searchParams.get("redirect_uri"), origin + GITHUB_CALLBACK_PATH);
  assert.equal(authorize.searchParams.get("scope"), GITHUB_SCOPES);
  assert.equal(authorize.searchParams.get("scope"), "read:user user:email");
  assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
  assert.match(authorize.searchParams.get("state") || "", /^[A-Za-z0-9_-]{43}$/);
  assert.match(authorize.searchParams.get("code_challenge") || "", /^[A-Za-z0-9_-]{43}$/);
  return authorize;
}

const callback = (origin, authorize, code = "code-fixture") =>
  fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&code=${code}`, { redirect: "manual" });

test("start redirects to GitHub with PKCE bound to the session slot", async t => {
  const f = createAcceptanceFixture();
  const fetchFn = githubFetch();
  const origin = await startServer(t, f, { githubAuth: githubAuth(fetchFn) });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  assert.equal(fetchFn.captured.codeVerifier, undefined, "no token exchange happens at start time");
  assert.ok(authorize.searchParams.get("code_challenge"));
});

test("start requires a valid session token", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const missing = await fetch(`${origin}${GITHUB_START_PATH}`, { redirect: "manual" });
  assert.equal(missing.status, 401);
  const bogus = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=${"z".repeat(43)}`, { redirect: "manual" });
  assert.equal(bogus.status, 401);
});

test("start is 503 with honest JSON when GitHub is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=${slot.token}`, { redirect: "manual" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.reason, "github_not_configured");
  assert.equal(body.error.code, "github_not_configured");
  noSecrets(body);
});

test("start serves an honest HTML landing to browsers when GitHub is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const slot = f.store.createAccountSessionSlot();
  const res = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=${slot.token}`,
    { redirect: "manual", headers: { Accept: "text/html" } });
  assert.equal(res.status, 503);
  assert.ok(res.headers.get("content-type").includes("text/html"));
  const html = await res.text();
  assert.ok(html.includes("GitHub sign-in isn&rsquo;t configured") || html.includes("GitHub sign-in isn\u2019t configured"));
  assert.ok(html.includes("Back to sign-in"));
  noSecrets({ html });
});

test("start rejects non-GET methods", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const res = await fetch(`${origin}${GITHUB_START_PATH}?sessionToken=x`, { method: "POST" });
  assert.equal(res.status, 405);
});

test("start->callback roundtrip upgrades the slot and provisions github:<id>", async t => {
  const f = createAcceptanceFixture();
  const fetchFn = githubFetch();
  const origin = await startServer(t, f, { githubAuth: githubAuth(fetchFn) });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const res = await callback(origin, authorize);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.status, "ok");
  assert.equal(body.provider, "github");
  assert.equal(body.account.id, `github:${userId}`);
  assert.equal(body.sessionRevision, 1);
  assert.equal(body.method.kind, "oauth");
  noSecrets(body);
  // The presented PKCE verifier matches the challenge from the authorize URL.
  assert.equal(codeChallengeFor(fetchFn.captured.codeVerifier), authorize.searchParams.get("code_challenge"));
  // The login minted a fresh slot token (QAS-702 session-fixation fix): the
  // pre-login token is dead and the fresh cookie token authenticates the
  // new account with the carried-over revision.
  const fresh = accountCookie(res);
  assert.ok(fresh && fresh !== slot.token, "GitHub login rotates the slot token");
  assert.throws(() => f.store.authenticateAccountSession(slot.token), { code: "unauthenticated" });
  const session = f.store.authenticateAccountSession(fresh);
  assert.equal(session.account.id, `github:${userId}`);
  assert.equal(session.sessionRevision, 1);
  // The account row is keyed on the GitHub subject, never the email address.
  const row = f.store.db.prepare("SELECT id, origin FROM accounts WHERE id=?").get(`github:${userId}`);
  assert.equal(row.origin, "github-oauth");
  // An oauth login method was linked and touched.
  const methods = f.store.accountLogins.listMethods(`github:${userId}`);
  assert.equal(methods.length, 2, "oauth + magic-link methods");
  const oauth = methods.find(m => m.type === "oauth");
  assert.equal(oauth.provider, "github");
  assert.equal(oauth.email, verifiedEmail);
  assert.ok(oauth.lastUsedAt !== null);
  assert.ok(methods.some(m => m.type === "magic" && m.email === verifiedEmail));
});

test("second login with the same GitHub subject reuses the account", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  for (let i = 0; i < 2; i++) {
    const slot = f.store.createAccountSessionSlot();
    const authorize = await beginFlow(origin, slot.token);
    const res = await callback(origin, authorize, `code-${i}`);
    assert.equal(res.status, 200);
    assert.equal((await res.json()).account.id, `github:${userId}`);
  }
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id=?").get(`github:${userId}`).n, 1);
  assert.equal(f.store.accountLogins.listMethods(`github:${userId}`).filter(m => m.type === "oauth").length, 1);
});

test("replaying a consumed state is 401 and provisions nothing new", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const first = await callback(origin, authorize);
  assert.equal(first.status, 200);
  const replay = await callback(origin, authorize);
  assert.equal(replay.status, 401);
  const body = await replay.json();
  assert.equal(body.error.code, "github_state_invalid");
  noSecrets(body);
});

test("an unknown state is 401", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const res = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=${"x".repeat(43)}&code=code-fixture`, { redirect: "manual" });
  assert.equal(res.status, 401);
  assert.equal((await res.json()).error.code, "github_state_invalid");
});

test("a rejected grant (PKCE mismatch) is 401", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const res = await callback(origin, authorize, "pkce-fixture");
  assert.equal(res.status, 401);
  const body = await res.json();
  assert.equal(body.error.code, "github_token_rejected");
  noSecrets(body);
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id LIKE 'github:%'").get().n, 0);
});

test("verified-email linking lands on the existing account", async t => {
  const f = createAcceptanceFixture();
  const emailAccountId = `email:${createHash("sha256").update(verifiedEmail, "utf8").digest("hex")}`;
  f.store.createAccount(emailAccountId, "test");
  f.store.accountLogins.linkMagicMethod(emailAccountId, { email: verifiedEmail });
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const res = await callback(origin, authorize);
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.account.id, emailAccountId, "no new github:<id> account is provisioned");
  const methods = f.store.accountLogins.listMethods(emailAccountId);
  const oauth = methods.find(m => m.type === "oauth");
  assert.ok(oauth, "the GitHub subject is linked onto the existing account");
  assert.equal(oauth.provider, "github");
  assert.equal(f.store.db.prepare("SELECT count(*) AS n FROM accounts WHERE id=?").get(`github:${userId}`).n, 0);
});

test("an unverified email is never trusted for linking", async t => {
  const f = createAcceptanceFixture();
  const fetchFn = githubFetch({ emails: [{ email: "untrusted@example.com", primary: true, verified: false }] });
  const origin = await startServer(t, f, { githubAuth: githubAuth(fetchFn) });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const res = await callback(origin, authorize);
  assert.equal(res.status, 200);
  assert.equal((await res.json()).account.id, `github:${userId}`);
  const methods = f.store.accountLogins.listMethods(`github:${userId}`);
  assert.equal(methods.length, 1, "oauth only: no magic-link method without a verified email");
  assert.equal(methods[0].type, "oauth");
  assert.equal(methods[0].email, null);
});

test("callback surfaces 409 when the subject was linked elsewhere mid-flow", async t => {
  // Subject "999" already belongs to account A, but the callback's owner
  // lookup is forced to miss (a concurrent-link race), so linking proceeds
  // toward account B through the verified email — and linkOAuthMethod
  // rejects the cross-account reuse with 409 login_method_exists, which the
  // route surfaces as-is through the generic error handler.
  const f = createAcceptanceFixture();
  const accountA = f.store.createAccount("slice4-acct-a", "test");
  const accountB = f.store.createAccount("slice4-acct-b", "test");
  f.store.accountLogins.linkOAuthMethod(accountA.id, { provider: "github", subject: "999", email: "a@example.com" });
  f.store.accountLogins.linkMagicMethod(accountB.id, { email: verifiedEmail });
  const fetchFn = githubFetch({ id: 999 });
  const origin = await startServer(t, f, { githubAuth: githubAuth(fetchFn) });
  const realFind = f.store.accountLogins.findAccountByOAuth.bind(f.store.accountLogins);
  let calls = 0;
  f.store.accountLogins.findAccountByOAuth = (...args) => (++calls === 1 ? null : realFind(...args));
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const res = await callback(origin, authorize);
  assert.equal(res.status, 409);
  const body = await res.json();
  assert.equal(body.error.code, "login_method_exists");
  noSecrets(body);
});

test("callback is 503 with honest JSON when GitHub is not configured", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f);
  const res = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=${"y".repeat(43)}&code=x`, { redirect: "manual" });
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.status, "unavailable");
  assert.equal(body.reason, "github_not_configured");
  assert.equal(body.error.code, "github_not_configured");
  noSecrets(body);
});

test("callback rejects non-GET methods", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const res = await fetch(`${origin}${GITHUB_CALLBACK_PATH}?state=x&code=y`, { method: "POST" });
  assert.equal(res.status, 405);
});

test("callback with a provider denial is 401 and burns the state", async t => {
  const f = createAcceptanceFixture();
  const origin = await startServer(t, f, { githubAuth: githubAuth() });
  const slot = f.store.createAccountSessionSlot();
  const authorize = await beginFlow(origin, slot.token);
  const denied = await fetch(
    `${origin}${GITHUB_CALLBACK_PATH}?state=${authorize.searchParams.get("state")}&error=access_denied`, { redirect: "manual" });
  assert.equal(denied.status, 401);
  assert.equal((await denied.json()).error.code, "github_consent_denied");
  // The burned state cannot be reused afterwards.
  const replay = await callback(origin, authorize);
  assert.equal(replay.status, 401);
});

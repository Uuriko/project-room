// Unit tests for server/github-oauth.mjs (slice 4, RC-2026-09-17-013):
// PKCE S256, the authorize URL, the single-use pending-state store, the
// token exchange and user fetch against a stubbed fetch (no real network),
// and the honest unconfigured state. node:test + node:assert/strict.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  GITHUB_START_PATH, GITHUB_CALLBACK_PATH, GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL,
  GITHUB_USER_URL, GITHUB_EMAILS_URL, GITHUB_SCOPES,
  GitHubOAuthError, isGitHubConfigured, createCodeVerifier, codeChallengeFor,
  buildGitHubAuthUrl, createPendingStore, exchangeCodeForToken, fetchGitHubUser
} from "../server/github-oauth.mjs";

const clientId = "Iv1.fixtureclientid0000";
const redirectUri = "https://room.example" + GITHUB_CALLBACK_PATH;
const state = randomBytes(32).toString("base64url");
assert.equal(GITHUB_START_PATH, "/api/auth/github/start");
assert.equal(GITHUB_CALLBACK_PATH, "/api/auth/github/callback");

const throwsCode = async (fn, code) => {
  try { await fn(); } catch (error) {
    assert.ok(error instanceof GitHubOAuthError, `expected GitHubOAuthError, got ${error}`);
    assert.equal(error.code, code);
    return;
  }
  assert.fail(`expected GitHubOAuthError(${code})`);
};

test("PKCE S256: verifier is 43-128 chars and the challenge is base64url(sha256(verifier))", () => {
  const verifier = createCodeVerifier();
  assert.match(verifier, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(codeChallengeFor(verifier), createHash("sha256").update(verifier, "utf8").digest("base64url"));
  assert.equal(codeChallengeFor("a".repeat(43)).length, 43);
  assert.throws(() => codeChallengeFor("short"), error => error instanceof GitHubOAuthError && error.code === "github_verifier_invalid");
});

test("authorize URL carries the GitHub endpoint, scope, state and PKCE", () => {
  const verifier = createCodeVerifier();
  const url = new URL(buildGitHubAuthUrl({ clientId, redirectUri, state, codeChallenge: codeChallengeFor(verifier) }));
  assert.equal(url.origin + url.pathname, GITHUB_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), clientId);
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("scope"), GITHUB_SCOPES);
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
  assert.equal(url.searchParams.get("state"), state);
  assert.equal(url.searchParams.get("code_challenge"), codeChallengeFor(verifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("authorize URL rejects bad config", () => {
  const verifier = createCodeVerifier();
  assert.throws(() => buildGitHubAuthUrl({ clientId: "", redirectUri, state, codeChallenge: codeChallengeFor(verifier) }),
    error => error.code === "github_configuration_invalid");
  assert.throws(() => buildGitHubAuthUrl({ clientId, redirectUri: "https://room.example/wrong", state, codeChallenge: codeChallengeFor(verifier) }),
    error => error.code === "github_configuration_invalid");
});

test("pending store: create then single-use consume", () => {
  const store = createPendingStore();
  const slotToken = randomBytes(32).toString("base64url");
  const created = store.create({ sessionToken: slotToken, sessionRevision: 3 });
  assert.match(created.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  const consumed = store.consume(created.state);
  assert.equal(consumed.codeVerifier, created.codeVerifier);
  assert.equal(consumed.sessionToken, slotToken);
  assert.equal(consumed.sessionRevision, 3);
});

test("pending store: replay of a consumed state is rejected", async () => {
  const store = createPendingStore();
  const slotToken = randomBytes(32).toString("base64url");
  const created = store.create({ sessionToken: slotToken, sessionRevision: 0 });
  store.consume(created.state);
  await throwsCode(() => store.consume(created.state), "github_state_invalid");
});

test("pending store: unknown and malformed states are rejected", async () => {
  const store = createPendingStore();
  await throwsCode(() => store.consume(randomBytes(32).toString("base64url")), "github_state_invalid");
  await throwsCode(() => store.consume(""), "github_state_invalid");
  await throwsCode(() => store.consume(null), "github_state_invalid");
});

test("pending store: expired states are rejected and dropped", async () => {
  let at = 1_000_000;
  const store = createPendingStore({ now: () => at, ttlMs: 60_000 });
  const slotToken = randomBytes(32).toString("base64url");
  const created = store.create({ sessionToken: slotToken, sessionRevision: 0 });
  at += 60_001;
  await throwsCode(() => store.consume(created.state), "github_state_expired");
  assert.equal(store.size(), 0, "expired entries are dropped on consume");
});

test("pending store: the table is bounded and evicts the oldest entries", () => {
  const store = createPendingStore({ max: 3 });
  const slotToken = () => randomBytes(32).toString("base64url");
  const first = store.create({ sessionToken: slotToken(), sessionRevision: 0 });
  store.create({ sessionToken: slotToken(), sessionRevision: 0 });
  store.create({ sessionToken: slotToken(), sessionRevision: 0 });
  store.create({ sessionToken: slotToken(), sessionRevision: 0 });
  assert.equal(store.size(), 3);
  // The oldest entry was evicted to make room.
  return throwsCode(() => store.consume(first.state), "github_state_invalid");
});

test("pending store: rejects invalid slot bindings at create time", () => {
  const store = createPendingStore();
  assert.throws(() => store.create({ sessionToken: "bad", sessionRevision: 0 }),
    error => error.code === "github_session_required");
  assert.throws(() => store.create({ sessionToken: randomBytes(32).toString("base64url"), sessionRevision: -1 }),
    error => error.code === "github_session_required");
});

const stubFetch = handler => {
  const calls = [];
  const fetchFn = async (url, init) => { calls.push({ url, init }); return handler(url, init); };
  fetchFn.calls = calls;
  return fetchFn;
};

test("token exchange posts the code and PKCE verifier with Accept: application/json", async () => {
  const verifier = createCodeVerifier();
  const fetchFn = stubFetch((url, init) => {
    assert.equal(url, GITHUB_TOKEN_URL);
    assert.equal(init.method, "POST");
    assert.equal(init.headers.Accept, "application/json");
    const body = new URLSearchParams(init.body);
    assert.equal(body.get("client_id"), clientId);
    assert.equal(body.get("client_secret"), "fixture-secret");
    assert.equal(body.get("code"), "code-123");
    assert.equal(body.get("code_verifier"), verifier);
    assert.equal(body.get("redirect_uri"), redirectUri);
    return Response.json({ access_token: "gho_fixturetoken", token_type: "bearer", scope: GITHUB_SCOPES });
  });
  const token = await exchangeCodeForToken({ code: "code-123", codeVerifier: verifier, clientId,
    clientSecret: "fixture-secret", redirectUri, fetchFn });
  assert.equal(token, "gho_fixturetoken");
  assert.equal(fetchFn.calls.length, 1);
});

test("token exchange: provider error bodies and rejections surface distinctly", async () => {
  const verifier = createCodeVerifier();
  const args = { code: "code-123", codeVerifier: verifier, clientId, clientSecret: "fixture-secret", redirectUri };
  await throwsCode(() => exchangeCodeForToken({ ...args,
    fetchFn: stubFetch(() => Response.json({ error: "incorrect_code_verifier" })) }), "github_token_rejected");
  await throwsCode(() => exchangeCodeForToken({ ...args,
    fetchFn: stubFetch(() => new Response("denied", { status: 400 })) }), "github_token_rejected");
  await throwsCode(() => exchangeCodeForToken({ ...args,
    fetchFn: stubFetch(() => { throw new TypeError("network down"); }) }), "github_provider_unavailable");
  await throwsCode(() => exchangeCodeForToken({ ...args,
    fetchFn: stubFetch(() => Response.json({ token_type: "bearer" })) }), "github_token_invalid");
});

test("user fetch reads /user and the primary verified email", async () => {
  const fetchFn = stubFetch(url => {
    if (url === GITHUB_USER_URL) return Response.json({ id: 424242, login: "octofixture" });
    if (url === GITHUB_EMAILS_URL) return Response.json([
      { email: "other@example.com", primary: false, verified: true },
      { email: "unverified@example.com", primary: false, verified: false },
      { email: "gh-user@example.com", primary: true, verified: true }
    ]);
    return new Response("missing", { status: 404 });
  });
  const user = await fetchGitHubUser("gho_fixturetoken", fetchFn);
  assert.equal(user.id, 424242);
  assert.equal(user.login, "octofixture");
  assert.equal(user.email, "gh-user@example.com");
  for (const call of fetchFn.calls) {
    assert.equal(call.init.headers.Authorization, "Bearer gho_fixturetoken");
  }
  assert.equal(fetchFn.calls.length, 2);
});

test("user fetch: unverified or missing primary email yields null (never trusted)", async () => {
  const unverified = stubFetch(url => {
    if (url === GITHUB_USER_URL) return Response.json({ id: 7, login: "nobody" });
    return Response.json([{ email: "nope@example.com", primary: true, verified: false }]);
  });
  assert.equal((await fetchGitHubUser("t", unverified)).email, null);
  const nonePrimary = stubFetch(url => {
    if (url === GITHUB_USER_URL) return Response.json({ id: 7, login: "nobody" });
    return Response.json([{ email: "a@example.com", primary: false, verified: true }]);
  });
  assert.equal((await fetchGitHubUser("t", nonePrimary)).email, null);
});

test("user fetch: bad subjects and provider failures are rejected", async () => {
  const badId = stubFetch(url => {
    if (url === GITHUB_USER_URL) return Response.json({ id: "not-a-number", login: "x" });
    return Response.json([]);
  });
  await throwsCode(() => fetchGitHubUser("t", badId), "github_user_invalid");
  const down = stubFetch(() => new Response("gone", { status: 500 }));
  await throwsCode(() => fetchGitHubUser("t", down), "github_provider_rejected");
  const notArray = stubFetch(url => {
    if (url === GITHUB_USER_URL) return Response.json({ id: 7, login: "x" });
    return Response.json({ email: "shaped-wrong@example.com" });
  });
  await throwsCode(() => fetchGitHubUser("t", notArray), "github_user_invalid");
});

test("pending store: invalid bounds are rejected at construction", () => {
  assert.throws(() => createPendingStore({ max: 0 }), error => error.code === "github_pending_invalid");
  assert.throws(() => createPendingStore({ max: -2 }), error => error.code === "github_pending_invalid");
  assert.throws(() => createPendingStore({ ttlMs: -1 }), error => error.code === "github_pending_invalid");
});

test("isGitHubConfigured needs both the client id and the client secret", () => {
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "secret" }), true);
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_ID: "id" }), false);
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_SECRET: "secret" }), false);
  assert.equal(isGitHubConfigured({}), false);
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_ID: "", GITHUB_OAUTH_CLIENT_SECRET: "secret" }), false);
});

// Unit tests for server/github-oauth.mjs (slice 4, RC-2026-09-17-013):
// PKCE S256, the authorize URL, the stateless sealed pending state
// (RC-2026-09-19-076), the token exchange and user fetch against a stubbed
// fetch (no real network), and the honest unconfigured state.
// node:test + node:assert/strict.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  GITHUB_START_PATH, GITHUB_CALLBACK_PATH, GITHUB_AUTHORIZE_URL, GITHUB_TOKEN_URL,
  GITHUB_USER_URL, GITHUB_EMAILS_URL, GITHUB_SCOPES,
  GitHubOAuthError, isGitHubConfigured, createCodeVerifier, codeChallengeFor,
  buildGitHubAuthUrl, issueGitHubOAuthState, consumeGitHubOAuthState,
  exchangeCodeForToken, fetchGitHubUser
} from "../server/github-oauth.mjs";
import { isSealedOAuthState } from "../server/oauth-state-seal.mjs";

const clientId = "Iv1.fixtureclientid0000";
const clientSecret = "fixture-secret-never-real";
const redirectUri = "https://room.example" + GITHUB_CALLBACK_PATH;
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

const issueState = (overrides = {}) => issueGitHubOAuthState({ clientSecret,
  sessionToken: randomBytes(32).toString("base64url"), sessionRevision: 0,
  redirectUri, ...overrides });

test("authorize URL carries the GitHub endpoint, scope, state and PKCE", () => {
  const verifier = createCodeVerifier();
  const { state } = issueState();
  const url = new URL(buildGitHubAuthUrl({ clientId, redirectUri, state, codeChallenge: codeChallengeFor(verifier) }));
  assert.equal(url.origin + url.pathname, GITHUB_AUTHORIZE_URL);
  assert.equal(url.searchParams.get("client_id"), clientId);
  assert.equal(url.searchParams.get("redirect_uri"), redirectUri);
  assert.equal(url.searchParams.get("scope"), GITHUB_SCOPES);
  assert.equal(url.searchParams.get("scope"), "read:user user:email");
  assert.equal(url.searchParams.get("state"), state);
  assert.ok(isSealedOAuthState(state), "state is the sealed stateless blob");
  assert.equal(url.searchParams.get("code_challenge"), codeChallengeFor(verifier));
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
});

test("authorize URL rejects bad config", () => {
  const verifier = createCodeVerifier();
  const { state } = issueState();
  assert.throws(() => buildGitHubAuthUrl({ clientId: "", redirectUri, state, codeChallenge: codeChallengeFor(verifier) }),
    error => error.code === "github_configuration_invalid");
  assert.throws(() => buildGitHubAuthUrl({ clientId, redirectUri: "https://room.example/wrong", state, codeChallenge: codeChallengeFor(verifier) }),
    error => error.code === "github_configuration_invalid");
  // A raw nonce is no longer acceptable state — only the sealed blob is.
  assert.throws(() => buildGitHubAuthUrl({ clientId, redirectUri,
    state: randomBytes(32).toString("base64url"), codeChallenge: codeChallengeFor(verifier) }),
    error => error.code === "github_configuration_invalid");
});

test("stateless state: issue then consume round-trips the slot binding", () => {
  const slotToken = randomBytes(32).toString("base64url");
  const issued = issueGitHubOAuthState({ clientSecret, sessionToken: slotToken, sessionRevision: 3,
    link: true, redirectUri });
  assert.ok(isSealedOAuthState(issued.state));
  assert.match(issued.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  // No shared memory: consume with only the secret.
  const consumed = consumeGitHubOAuthState({ clientSecret, state: issued.state, redirectUri });
  assert.equal(consumed.codeVerifier, issued.codeVerifier);
  assert.equal(consumed.sessionToken, slotToken);
  assert.equal(consumed.sessionRevision, 3);
  assert.equal(consumed.link, true);
});

test("stateless state: a blob is single-issuance — re-issue differs, replay is the provider's job", () => {
  const first = issueState();
  const second = issueState();
  assert.notEqual(first.state, second.state, "fresh nonce per issuance");
});

test("stateless state: unknown and malformed states are rejected", async () => {
  await throwsCode(() => consumeGitHubOAuthState({ clientSecret, state: randomBytes(32).toString("base64url"),
    redirectUri }), "github_state_invalid");
  await throwsCode(() => consumeGitHubOAuthState({ clientSecret, state: "", redirectUri }), "github_state_invalid");
  await throwsCode(() => consumeGitHubOAuthState({ clientSecret, state: null, redirectUri }), "github_state_invalid");
  await throwsCode(() => consumeGitHubOAuthState({ clientSecret, state: issueState().state,
    redirectUri: "https://room.example/api/auth/github/callback-evil" }), "github_state_invalid");
});

test("stateless state: expired states are rejected", async () => {
  let at = 1_000_000;
  const issued = issueGitHubOAuthState({ clientSecret, sessionToken: randomBytes(32).toString("base64url"),
    sessionRevision: 0, redirectUri, now: () => at, ttlMs: 60_000 });
  at += 60_001;
  await throwsCode(() => consumeGitHubOAuthState({ clientSecret, state: issued.state, redirectUri, now: () => at }),
    "github_state_expired");
});

test("stateless state: a rotated client secret fails closed", async () => {
  const issued = issueState();
  await throwsCode(() => consumeGitHubOAuthState({ clientSecret: "a-different-secret", state: issued.state,
    redirectUri }), "github_state_invalid");
});

test("stateless state: rejects invalid slot bindings at issue time", () => {
  assert.throws(() => issueGitHubOAuthState({ clientSecret, sessionToken: "bad", sessionRevision: 0, redirectUri }),
    error => error.code === "github_session_required");
  assert.throws(() => issueGitHubOAuthState({ clientSecret,
    sessionToken: randomBytes(32).toString("base64url"), sessionRevision: -1, redirectUri }),
    error => error.code === "github_session_required");
  assert.throws(() => issueGitHubOAuthState({ clientSecret,
    sessionToken: randomBytes(32).toString("base64url"), sessionRevision: 0,
    redirectUri: "https://room.example/wrong" }),
    error => error.code === "github_state_invalid");
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

// No construction-time bounds anymore: there is no table to bound.
// Stateless state expiry is carried inside each sealed blob.

test("isGitHubConfigured needs both the client id and the client secret", () => {
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_ID: "id", GITHUB_OAUTH_CLIENT_SECRET: "secret" }), true);
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_ID: "id" }), false);
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_SECRET: "secret" }), false);
  assert.equal(isGitHubConfigured({}), false);
  assert.equal(isGitHubConfigured({ GITHUB_OAUTH_CLIENT_ID: "", GITHUB_OAUTH_CLIENT_SECRET: "secret" }), false);
});

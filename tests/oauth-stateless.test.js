// RC-2026-09-19-076 (QAX-003): OAuth pending PKCE/state is stateless —
// AES-GCM-sealed into the `state` param with a key derived from the OAuth
// client secret via HKDF. These tests prove the blob survives a "restart"
// (a fresh provider instance with the same secret opens it), that it
// fails closed on tamper/expiry/wrong secret/wrong redirect, and that both
// providers' begin/complete round-trips carry the slot binding.
import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import {
  OAUTH_STATE_TTL_MS, OAuthStateError, isSealedOAuthState, sealOAuthState, unsealOAuthState
} from "../server/oauth-state-seal.mjs";
import { GoogleSignIn, GoogleOAuthError, GOOGLE_ISSUER, GOOGLE_CALLBACK_PATH } from "../server/google-oauth.mjs";
import { GitHubOAuthError, issueGitHubOAuthState, consumeGitHubOAuthState,
  GITHUB_CALLBACK_PATH } from "../server/github-oauth.mjs";

const clientSecret = "fixture-secret-never-real";
const otherSecret = "a-totally-different-secret";
const redirectUri = "https://room.example" + GOOGLE_CALLBACK_PATH;
const githubRedirect = "https://room.example" + GITHUB_CALLBACK_PATH;
const slotToken = () => randomBytes(32).toString("base64url");
const verifier = () => randomBytes(32).toString("base64url");

const sealArgs = (overrides = {}) => ({
  clientSecret, provider: "google", codeVerifier: verifier(), slotToken: slotToken(),
  sessionRevision: 7, link: false, redirectUri, ...overrides
});

test("seal/unseal round-trips the payload and rejects non-sealed input", () => {
  const token = slotToken();
  const state = sealOAuthState(sealArgs({ slotToken: token, sessionRevision: 3, link: true }));
  assert.ok(isSealedOAuthState(state));
  const opened = unsealOAuthState({ clientSecret, provider: "google", state, redirectUri });
  assert.equal(opened.slotToken, token);
  assert.equal(opened.sessionRevision, 3);
  assert.equal(opened.link, true);
  assert.match(opened.codeVerifier, /^[A-Za-z0-9_-]{43}$/);
  assert.ok(opened.expiresAt - opened.issuedAt <= OAUTH_STATE_TTL_MS);
  assert.equal(isSealedOAuthState("x".repeat(43)), false);
  assert.equal(isSealedOAuthState(""), false);
  assert.equal(isSealedOAuthState(null), false);
});

test("the blob is opaque: it leaks neither the slot token nor the verifier", () => {
  const token = slotToken();
  const cv = verifier();
  const state = sealOAuthState(sealArgs({ slotToken: token, codeVerifier: cv }));
  assert.equal(state.includes(token), false);
  assert.equal(state.includes(cv), false);
  assert.equal(state.includes(clientSecret), false);
});

test("unseal needs no server memory: only the client secret matters", () => {
  // Seal in one "isolate", unseal in another — there is no shared Map.
  const token = slotToken();
  const state = sealOAuthState(sealArgs({ slotToken: token }));
  const opened = unsealOAuthState({ clientSecret, provider: "google", state, redirectUri });
  assert.equal(opened.slotToken, token);
});

test("a rotated or wrong client secret fails closed", () => {
  const state = sealOAuthState(sealArgs());
  assert.throws(() => unsealOAuthState({ clientSecret: otherSecret, provider: "google", state, redirectUri }),
    error => error instanceof OAuthStateError && error.kind === "invalid");
});

test("any tamper with the blob fails closed", () => {
  const state = sealOAuthState(sealArgs());
  const tampered = state.slice(0, -6) + (state.endsWith("AAAAAA") ? "BBBBBB" : "AAAAAA");
  assert.ok(isSealedOAuthState(tampered), "still well-formed base64url");
  assert.notEqual(tampered, state);
  assert.throws(() => unsealOAuthState({ clientSecret, provider: "google", state: tampered, redirectUri }),
    error => error instanceof OAuthStateError && error.kind === "invalid");
  // Truncation and prefix swaps are invalid too.
  assert.throws(() => unsealOAuthState({ clientSecret, provider: "google",
    state: state.slice(0, 40), redirectUri }), error => error.kind === "invalid");
  assert.throws(() => unsealOAuthState({ clientSecret, provider: "google",
    state: "os2." + state.slice(4), redirectUri }), error => error.kind === "invalid");
});

test("expired blobs fail with kind=expired (callers map to their own code)", () => {
  let at = 5_000_000;
  const state = sealOAuthState({ ...sealArgs(), ttlMs: 60_000, now: () => at });
  at += 60_001;
  assert.throws(() => unsealOAuthState({ clientSecret, provider: "google", state, redirectUri, now: () => at }),
    error => error instanceof OAuthStateError && error.kind === "expired");
});

test("provider label and redirect binding are enforced", () => {
  const state = sealOAuthState(sealArgs());
  assert.throws(() => unsealOAuthState({ clientSecret, provider: "github", state, redirectUri }),
    error => error.kind === "invalid");
  assert.throws(() => unsealOAuthState({ clientSecret, provider: "google", state,
    redirectUri: "https://room.example/api/auth/google/callback-evil" }),
    error => error.kind === "invalid");
});

test("seal validates its inputs", () => {
  assert.throws(() => sealOAuthState({ ...sealArgs(), clientSecret: "" }), error => error.kind === "invalid");
  assert.throws(() => sealOAuthState({ ...sealArgs(), slotToken: "bad" }), error => error.kind === "invalid");
  assert.throws(() => sealOAuthState({ ...sealArgs(), sessionRevision: -1 }), error => error.kind === "invalid");
});

// --- Google begin/complete across a simulated restart ---

const googleClientId = "1234567890-abcdefghijklmnopqrstuvwxyz.apps.googleusercontent.com";
const googleSub = "123456789012345678901";
const googleKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const googleJwk = googleKeys.publicKey.export({ format: "jwk" });
googleJwk.kid = "stateless-kid";
googleJwk.alg = "RS256";
googleJwk.use = "sig";

function googleIdToken() {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: googleJwk.kid })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: GOOGLE_ISSUER, sub: googleSub, aud: googleClientId, iat: now, exp: now + 600,
    email: "stateless@example.com", email_verified: true
  })).toString("base64url");
  const input = `${header}.${payload}`;
  return `${input}.${sign("RSA-SHA256", Buffer.from(input), googleKeys.privateKey).toString("base64url")}`;
}

const googleFetch = async url => {
  if (url === "https://oauth2.googleapis.com/token") {
    return Response.json({ id_token: googleIdToken(), scope: "openid email profile" });
  }
  if (url === "https://www.googleapis.com/oauth2/v3/certs") return Response.json({ keys: [googleJwk] });
  return new Response("missing", { status: 404 });
};

test("Google begin/complete round-trips across a simulated restart, carrying the email", async () => {
  const token = slotToken();
  const before = new GoogleSignIn({ clientId: googleClientId, clientSecret, redirectUri, fetchImpl: googleFetch });
  const { authorizationUrl } = before.begin({ slotToken: token, expectedRevision: 9, link: true });
  const state = new URL(authorizationUrl).searchParams.get("state");
  assert.ok(isSealedOAuthState(state));
  // The "restart": drop `before` entirely; the fresh instance only shares
  // the configured client secret.
  const after = new GoogleSignIn({ clientId: googleClientId, clientSecret, redirectUri, fetchImpl: googleFetch });
  const completed = await after.complete({ callbackUrl: `${redirectUri}?state=${state}&code=code-1` });
  assert.equal(completed.claims.sub, googleSub);
  assert.equal(completed.claims.email, "stateless@example.com");
  assert.equal(completed.slotToken, token);
  assert.equal(completed.expectedRevision, 9);
  assert.equal(completed.link, true);
});

test("Google complete rejects a blob sealed for another provider or secret", async () => {
  const token = slotToken();
  const signer = new GoogleSignIn({ clientId: googleClientId, clientSecret, redirectUri, fetchImpl: googleFetch });
  const { authorizationUrl } = signer.begin({ slotToken: token, expectedRevision: 0 });
  const state = new URL(authorizationUrl).searchParams.get("state");
  const wrongSecret = new GoogleSignIn({ clientId: googleClientId, clientSecret: otherSecret,
    redirectUri, fetchImpl: googleFetch });
  await assert.rejects(() => wrongSecret.complete({ callbackUrl: `${redirectUri}?state=${state}&code=x` }),
    error => error instanceof GoogleOAuthError && error.code === "google_state_invalid");
  const githubState = sealOAuthState({ clientSecret, provider: "github", codeVerifier: verifier(),
    slotToken: token, sessionRevision: 0, redirectUri });
  await assert.rejects(() => signer.complete({ callbackUrl: `${redirectUri}?state=${githubState}&code=x` }),
    error => error instanceof GoogleOAuthError && error.code === "google_state_invalid");
});

// --- GitHub issue/consume across a simulated restart ---

test("GitHub issue/consume round-trips with no shared memory", () => {
  const token = slotToken();
  const issued = issueGitHubOAuthState({ clientSecret, sessionToken: token, sessionRevision: 2,
    link: true, redirectUri: githubRedirect });
  assert.ok(isSealedOAuthState(issued.state));
  // Fresh "isolate": only the secret is shared.
  const consumed = consumeGitHubOAuthState({ clientSecret, state: issued.state, redirectUri: githubRedirect });
  assert.equal(consumed.codeVerifier, issued.codeVerifier);
  assert.equal(consumed.sessionToken, token);
  assert.equal(consumed.sessionRevision, 2);
  assert.equal(consumed.link, true);
});

test("GitHub consume maps seal failures to GitHubOAuthError codes", async () => {
  const issued = issueGitHubOAuthState({ clientSecret, sessionToken: slotToken(), sessionRevision: 0,
    redirectUri: githubRedirect });
  const bad = async (fn, code) => {
    try { await fn(); } catch (error) {
      assert.ok(error instanceof GitHubOAuthError, `expected GitHubOAuthError, got ${error}`);
      assert.equal(error.code, code);
      return;
    }
    assert.fail(`expected GitHubOAuthError(${code})`);
  };
  await bad(() => consumeGitHubOAuthState({ clientSecret: otherSecret, state: issued.state,
    redirectUri: githubRedirect }), "github_state_invalid");
  await bad(() => consumeGitHubOAuthState({ clientSecret, state: "garbage", redirectUri: githubRedirect }),
    "github_state_invalid");
  let at = 5_000_000;
  const short = issueGitHubOAuthState({ clientSecret, sessionToken: slotToken(), sessionRevision: 0,
    redirectUri: githubRedirect, now: () => at, ttlMs: 60_000 });
  at += 60_001;
  await bad(() => consumeGitHubOAuthState({ clientSecret, state: short.state, redirectUri: githubRedirect,
    now: () => at }), "github_state_expired");
});

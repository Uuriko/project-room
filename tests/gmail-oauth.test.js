// Tests for src/gmail-oauth.mjs — pure OAuth connection logic for Gmail.
// No network calls, no real credentials: randomness and time are injected.
import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  GOOGLE_AUTHORIZE_URL,
  GOOGLE_TOKEN_URL,
  OAUTH_PURPOSES,
  scopesFor,
  buildAuthorizeUrl,
  buildTokenExchangeRequest,
  parseTokenResponse,
  connectionRecord,
  newPkcePair,
} from "../src/gmail-oauth.mjs";

const FIXED_NOW = Date.parse("2026-09-16T08:00:00.000Z");
const fixedClock = () => FIXED_NOW;
const fixedRandom = bytes => Buffer.alloc(bytes, 0xab); // -> "ababab..."
const deps = { random: fixedRandom, clock: fixedClock };

const READ = "https://www.googleapis.com/auth/gmail.readonly";
const SEND = "https://www.googleapis.com/auth/gmail.send";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";

const baseAuth = {
  clientId: "12345.apps.googleusercontent.com",
  redirectUri: "https://app.example.com/oauth/callback",
  scopes: [READ, SEND],
};

test("scopesFor maps each purpose to its Gmail scope URL", () => {
  assert.deepEqual(scopesFor("mail.read"), [READ]);
  assert.deepEqual(scopesFor("mail.send"), [SEND]);
  assert.deepEqual(scopesFor("mail.compose"), [COMPOSE]);
  assert.deepEqual([...OAUTH_PURPOSES].sort(), ["mail.compose", "mail.read", "mail.send"]);
  assert.throws(() => scopesFor("mail.delete"), { code: "GMAIL_UNKNOWN_PURPOSE" });
  assert.throws(() => scopesFor(""), { code: "GMAIL_UNKNOWN_PURPOSE" });
});

test("buildAuthorizeUrl produces the full Google authorization URL", () => {
  const url = new URL(buildAuthorizeUrl({ ...baseAuth, state: "state-123", codeChallenge: "chal-xyz" }, deps));
  assert.equal(`${url.origin}${url.pathname}`, GOOGLE_AUTHORIZE_URL);
  const p = url.searchParams;
  assert.equal(p.get("response_type"), "code");
  assert.equal(p.get("client_id"), baseAuth.clientId);
  assert.equal(p.get("redirect_uri"), baseAuth.redirectUri);
  assert.equal(p.get("scope"), `${READ} ${SEND}`);
  assert.equal(p.get("access_type"), "offline");
  assert.equal(p.get("prompt"), "consent");
  assert.equal(p.get("state"), "state-123");
  assert.equal(p.get("code_challenge"), "chal-xyz");
  assert.equal(p.get("code_challenge_method"), "S256");
});

test("buildAuthorizeUrl honors custom accessType/prompt and omits PKCE when absent", () => {
  const url = new URL(buildAuthorizeUrl({ ...baseAuth, accessType: "online", prompt: "select_account" }, deps));
  assert.equal(url.searchParams.get("access_type"), "online");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("code_challenge"), null);
  assert.equal(url.searchParams.get("code_challenge_method"), null);
});

test("buildAuthorizeUrl generates a state when none is given", () => {
  const a = new URL(buildAuthorizeUrl(baseAuth, deps)).searchParams.get("state");
  const b = new URL(buildAuthorizeUrl(baseAuth, { ...deps, random: bytes => Buffer.alloc(bytes, 0xcd) })).searchParams.get("state");
  assert.ok(a && a.startsWith("st_"), "auto state is an opaque ref");
  assert.notEqual(a, b, "state derives from injected randomness");
});

test("buildAuthorizeUrl allows http only for localhost", () => {
  for (const redirectUri of ["http://localhost:3000/cb", "http://127.0.0.1/cb", "https://app.example.com/cb"]) {
    const url = new URL(buildAuthorizeUrl({ ...baseAuth, redirectUri }, deps));
    assert.equal(url.searchParams.get("redirect_uri"), new URL(redirectUri).toString());
  }
});

test("buildAuthorizeUrl rejects bad input with coded errors", () => {
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, redirectUri: "http://app.example.com/cb" }, deps),
    { code: "GMAIL_INVALID_REDIRECT" });
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, redirectUri: "not-a-url" }, deps),
    { code: "GMAIL_INVALID_REDIRECT" });
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, redirectUri: "" }, deps),
    { code: "GMAIL_INVALID_REDIRECT" });
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, scopes: [] }, deps),
    { code: "GMAIL_EMPTY_SCOPES" });
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, scopes: "   " }, deps),
    { code: "GMAIL_EMPTY_SCOPES" });
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, clientId: "" }, deps),
    { code: "GMAIL_INVALID_CLIENT_ID" });
  assert.throws(() => buildAuthorizeUrl({ ...baseAuth, scopes: ["notaurl"] }, deps),
    { code: "GMAIL_INVALID_SCOPE" });
});

test("buildTokenExchangeRequest returns a POST shape without fetching", () => {
  const req = buildTokenExchangeRequest({
    clientId: baseAuth.clientId,
    redirectUri: baseAuth.redirectUri,
    code: "4/0-auth-code",
    codeVerifier: "verifier-abc",
  });
  assert.deepEqual(Object.keys(req).sort(), ["body", "headers", "method", "url"]);
  assert.equal(req.url, GOOGLE_TOKEN_URL);
  assert.equal(req.method, "POST");
  assert.equal(req.headers["content-type"], "application/x-www-form-urlencoded");
  const body = new URLSearchParams(req.body);
  assert.equal(body.get("grant_type"), "authorization_code");
  assert.equal(body.get("code"), "4/0-auth-code");
  assert.equal(body.get("redirect_uri"), baseAuth.redirectUri);
  assert.equal(body.get("client_id"), baseAuth.clientId);
  assert.equal(body.get("code_verifier"), "verifier-abc");
  assert.equal(body.get("client_secret"), null);
});

test("buildTokenExchangeRequest passes a client-secret ref through opaquely", () => {
  const req = buildTokenExchangeRequest({
    clientId: baseAuth.clientId,
    redirectUri: baseAuth.redirectUri,
    code: "4/0-auth-code",
    codeVerifier: "verifier-abc",
    clientSecretRef: "vault://gmail/client-secret",
  });
  assert.equal(new URLSearchParams(req.body).get("client_secret"), "vault://gmail/client-secret");
});

test("buildTokenExchangeRequest validates its inputs", () => {
  const good = { clientId: baseAuth.clientId, redirectUri: baseAuth.redirectUri, code: "c", codeVerifier: "v" };
  assert.throws(() => buildTokenExchangeRequest({ ...good, code: "" }), { code: "GMAIL_INVALID_CODE" });
  assert.throws(() => buildTokenExchangeRequest({ ...good, codeVerifier: "" }), { code: "GMAIL_INVALID_VERIFIER" });
  assert.throws(() => buildTokenExchangeRequest({ ...good, redirectUri: "http://evil.example.com/" }),
    { code: "GMAIL_INVALID_REDIRECT" });
  assert.throws(() => buildTokenExchangeRequest({ ...good, clientId: "" }), { code: "GMAIL_INVALID_CLIENT_ID" });
});

test("parseTokenResponse normalizes a full token response into opaque refs", () => {
  const raw = {
    access_token: "ya29.raw-access-secret",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "1//raw-refresh-secret",
    scope: `${READ} ${SEND}`,
  };
  const parsed = parseTokenResponse(raw, { accessType: "offline" }, deps);
  assert.match(parsed.accessTokenRef, /^gat_[0-9a-f]+$/);
  assert.match(parsed.refreshTokenRef, /^grt_[0-9a-f]+$/);
  assert.equal(parsed.expiresAt, "2026-09-16T09:00:00.000Z", "expiresAt = clock + expires_in");
  assert.deepEqual(parsed.scopesGranted, [READ, SEND]);
  assert.equal(parsed.tokenType, "Bearer");
  assert.equal(parsed.needsReconsent, false);
  assert.doesNotMatch(JSON.stringify(parsed), /ya29\.raw-access-secret|raw-refresh-secret/,
    "raw token values never enter the normalized shape");
});

test("parseTokenResponse flags a missing refresh_token for re-consent", () => {
  const parsed = parseTokenResponse({ access_token: "ya29.x", expires_in: 3599 }, { accessType: "offline" }, deps);
  assert.equal(parsed.refreshTokenRef, null);
  assert.equal(parsed.needsReconsent, true);
  assert.equal(parsed.expiresAt, "2026-09-16T08:59:59.000Z");
  assert.deepEqual(parsed.scopesGranted, []);
  assert.equal(parsed.tokenType, "Bearer", "token_type defaults to Bearer");
  const online = parseTokenResponse({ access_token: "ya29.x", expires_in: 100 }, { accessType: "online" }, deps);
  assert.equal(online.needsReconsent, false, "online access never expects a refresh token");
});

test("parseTokenResponse rejects bad responses", () => {
  assert.throws(() => parseTokenResponse({}, {}, deps), { code: "GMAIL_BAD_TOKEN_RESPONSE" });
  assert.throws(() => parseTokenResponse(null, {}, deps), { code: "GMAIL_BAD_TOKEN_RESPONSE" });
  assert.throws(() => parseTokenResponse("nope", {}, deps), { code: "GMAIL_BAD_TOKEN_RESPONSE" });
  assert.throws(() => parseTokenResponse({ access_token: "ya29.x" }, {}, deps),
    { code: "GMAIL_BAD_TOKEN_RESPONSE" }, "expires_in is required");
  assert.throws(() => parseTokenResponse({ access_token: "ya29.x", expires_in: "soon" }, {}, deps),
    { code: "GMAIL_BAD_TOKEN_RESPONSE" });
});

test("connectionRecord builds the storage shape with refs only", () => {
  const record = connectionRecord({
    accountId: "user@gmail.com",
    scopesGranted: [READ, SEND, READ],
    expiresAt: "2026-09-16T09:00:00.000Z",
    hasRefreshToken: true,
    accessTokenRef: "gat_abc123",
    refreshTokenRef: "grt_def456",
  }, deps);
  assert.deepEqual(record, {
    provider: "gmail",
    accountId: "user@gmail.com",
    scopes: [READ, SEND],
    status: "connected",
    connectedAt: "2026-09-16T08:00:00.000Z",
    tokenMeta: {
      expiresAt: "2026-09-16T09:00:00.000Z",
      hasRefreshToken: true,
      accessTokenRef: "gat_abc123",
      refreshTokenRef: "grt_def456",
    },
  });
  assert.throws(() => connectionRecord({ accountId: "", scopesGranted: [READ] }, deps),
    { code: "GMAIL_INVALID_ACCOUNT" });
  assert.throws(() => connectionRecord({ accountId: "user@gmail.com", scopesGranted: [] }, deps),
    { code: "GMAIL_EMPTY_SCOPES" });
});

test("token values stay opaque from token response through the stored record", () => {
  const parsed = parseTokenResponse({
    access_token: "ya29.planted-raw-access",
    expires_in: 3600,
    refresh_token: "1//planted-raw-refresh",
  }, { accessType: "offline" }, deps);
  const record = connectionRecord({
    accountId: "user@gmail.com",
    scopesGranted: parsed.scopesGranted.length ? parsed.scopesGranted : [READ],
    expiresAt: parsed.expiresAt,
    hasRefreshToken: parsed.refreshTokenRef !== null,
    accessTokenRef: parsed.accessTokenRef,
    refreshTokenRef: parsed.refreshTokenRef,
  }, deps);
  assert.doesNotMatch(JSON.stringify(record), /planted-raw-access|planted-raw-refresh/);
});

test("newPkcePair derives a valid S256 challenge from injected randomness", () => {
  const { verifier, challenge } = newPkcePair({}, deps);
  assert.equal(verifier, Buffer.alloc(32, 0xab).toString("base64url"));
  assert.equal(verifier.length, 43, "32 bytes -> 43 base64url chars, inside the 43..128 range");
  assert.equal(challenge, createHash("sha256").update(verifier, "ascii").digest("base64url"));
  assert.throws(() => newPkcePair({ bytes: 16 }, deps), { code: "GMAIL_INVALID_PKCE" });
});

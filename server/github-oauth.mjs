// Slice 4 (RC-2026-09-17-013) — GitHub OAuth sign-in (Clerk-free).
//
// Mirrors server/google-oauth.mjs's state+PKCE discipline: the browser's
// account-session slot is bound into a single-use pending state; the
// callback consumes the state, exchanges the code with PKCE S256, reads the
// GitHub user plus their /user/emails, and the HTTP layer links the
// verified subject into the multi-method login model
// (server/account-login-methods.mjs).
//
// This module is pure OAuth mechanics: no store, no HTTP routing. Time and
// randomness are injectable, and every network call goes through an
// injected fetchFn, so tests never touch the real network. Error responses
// never carry tokens.

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const GITHUB_START_PATH = "/api/auth/github/start";
export const GITHUB_CALLBACK_PATH = "/api/auth/github/callback";
export const GITHUB_AUTHORIZE_URL = "https://github.com/login/oauth/authorize";
export const GITHUB_TOKEN_URL = "https://github.com/login/oauth/access_token";
export const GITHUB_USER_URL = "https://api.github.com/user";
export const GITHUB_EMAILS_URL = "https://api.github.com/user/emails";
export const GITHUB_SCOPES = "read:user user:email";
export const GITHUB_PENDING_TTL_MS = 10 * 60 * 1000;
export const GITHUB_PENDING_MAX = 1000;

// Post-login landing page for browser OAuth navigations (slice 7): the
// GitHub callback content-negotiates — API clients keep the JSON body,
// browsers (Accept: text/html) get a page that navigates to the account
// home or the first room, mirroring the Google flow.
export function githubPostLoginPage(href) {
  if (href !== '/?github=error' && href !== '/?account=1' && !/^\/\?room=[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(href)) fail('github_callback_invalid');
  const safe = href.replace(/&/g, '&amp;');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${safe}"><title>Opening Project Room</title></head><body><p>Opening Room…</p><p><a href="${safe}">Continue</a></p></body></html>`;
}

// Honest unconfigured landing for browser navigations to the GitHub start
// route (slice 7): API clients keep the 503 JSON body, browsers
// (Accept: text/html) get a readable page instead of a raw error.
export function githubUnavailablePage() {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>GitHub sign-in unavailable</title></head><body><main><h1>GitHub sign-in isn&rsquo;t configured</h1><p>GitHub sign-in is not configured on this Room. An operator needs to add the GitHub OAuth credentials before it can be used.</p><p><a href="/?account=1">Back to sign-in</a></p></main></body></html>`;
}

export class GitHubOAuthError extends Error {
  constructor(code) { super(code); this.name = "GitHubOAuthError"; this.code = code; }
}
const fail = code => { throw new GitHubOAuthError(code); };

const digest = value => createHash("sha256").update(value, "utf8").digest("hex");
const opaque = value => typeof value === "string" && value.length > 0 && value.length <= 8192 && !/[\s\x00-\x1f\x7f]/.test(value);
const base64urlToken = bytes => bytes.toString("base64url");

// The HTTP layer treats a missing client id/secret as "not configured" and
// answers honestly instead of starting a flow that can never complete.
export function isGitHubConfigured(env = {}) {
  return typeof env.GITHUB_OAUTH_CLIENT_ID === "string" && env.GITHUB_OAUTH_CLIENT_ID.length > 0
    && typeof env.GITHUB_OAUTH_CLIENT_SECRET === "string" && env.GITHUB_OAUTH_CLIENT_SECRET.length > 0;
}

// PKCE S256: codeChallenge = base64url(sha256(codeVerifier)).
// The verifier is 256 bits of randomness (43 base64url chars), inside the
// RFC 7636 43-128 character window.
export function createCodeVerifier(random = randomBytes) {
  return base64urlToken(random(32));
}

export function codeChallengeFor(verifier) {
  if (typeof verifier !== "string" || verifier.length < 43 || verifier.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(verifier)) fail("github_verifier_invalid");
  return createHash("sha256").update(verifier, "utf8").digest("base64url");
}

export function buildGitHubAuthUrl({ clientId, redirectUri, state, codeChallenge }) {
  if (!opaque(clientId) || clientId.length > 256) fail("github_configuration_invalid");
  let redirect;
  try { redirect = new URL(redirectUri); } catch { fail("github_configuration_invalid"); }
  if (redirect.pathname !== GITHUB_CALLBACK_PATH || redirect.search || redirect.hash
    || redirect.username || redirect.password) fail("github_configuration_invalid");
  if (!/^[A-Za-z0-9_-]{43}$/.test(state || "") || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge || "")) {
    fail("github_configuration_invalid");
  }
  const url = new URL(GITHUB_AUTHORIZE_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirect.href,
    scope: GITHUB_SCOPES,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256"
  }).toString();
  return url.href;
}

// Single-use pending states binding a browser slot to its PKCE verifier.
// States are stored under sha256 digests and compared in constant time;
// entries expire after ttlMs and the table is bounded (oldest entries are
// evicted past max, so a flood of starts cannot grow memory without bound).
//
// Persistent backend (production): pass a `persistentStore` with
// { create({provider,stateHash,slotToken,expectedRevision,verifier,expiresAt,link}),
//   consume(provider,stateHash), delete(provider,stateHash) } backed by SQLite,
// so the callback survives Worker isolate eviction. Without it the in-memory
// Map is used (tests, single-process dev).
export function createPendingStore({ now = Date.now, ttlMs = GITHUB_PENDING_TTL_MS, random = randomBytes, max = GITHUB_PENDING_MAX, persistentStore = null } = {}) {
  if (!Number.isSafeInteger(ttlMs) || ttlMs < 0 || !Number.isSafeInteger(max) || max < 1) {
    throw new GitHubOAuthError("github_pending_invalid");
  }
  if (persistentStore) {
    return {
      size: () => 0, // bounded by the store's own limit
      create({ sessionToken, sessionRevision, link = false }) {
        if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken || "")
          || !Number.isSafeInteger(sessionRevision) || sessionRevision < 0) fail("github_session_required");
        const state = base64urlToken(random(32));
        const codeVerifier = createCodeVerifier(random);
        persistentStore.create({ provider: "github", stateHash: digest(state),
          slotToken: sessionToken, expectedRevision: sessionRevision,
          verifier: codeVerifier, expiresAt: now() + ttlMs, link: link === true });
        return { state, codeVerifier };
      },
      consume(state) {
        if (typeof state !== "string" || state.length === 0 || state.length > 256) fail("github_state_invalid");
        const entry = persistentStore.consume("github", digest(state));
        if (!entry) fail("github_state_invalid");
        return { codeVerifier: entry.verifier, sessionToken: entry.slotToken,
          sessionRevision: entry.expectedRevision, link: entry.link === true };
      }
    };
  }
  const pending = new Map(); // digest(state) -> { codeVerifier, sessionToken, sessionRevision, createdAt }
  const sweep = () => {
    const at = now();
    for (const [key, entry] of pending) {
      if (entry.createdAt + ttlMs <= at) pending.delete(key);
    }
  };
  return {
    size: () => pending.size,
    create({ sessionToken, sessionRevision, link = false }) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(sessionToken || "")
        || !Number.isSafeInteger(sessionRevision) || sessionRevision < 0) fail("github_session_required");
      sweep();
      while (pending.size >= max) {
        const oldest = pending.keys().next().value; // Map preserves insertion order
        if (oldest === undefined) break;
        pending.delete(oldest);
      }
      const state = base64urlToken(random(32));
      const codeVerifier = createCodeVerifier(random);
      // Slice 7: the settings "connect GitHub" flow carries a link intent so
      // the callback attaches the subject to the authenticated account.
      pending.set(digest(state), { codeVerifier, sessionToken, sessionRevision, link: link === true, createdAt: now() });
      return { state, codeVerifier };
    },
    consume(state) {
      if (typeof state !== "string" || state.length === 0 || state.length > 256) fail("github_state_invalid");
      const key = digest(state);
      let foundKey = null, entry = null;
      for (const candidate of pending.keys()) {
        // Fixed-length hex digests: timingSafeEqual is exact here.
        if (candidate.length === key.length
          && timingSafeEqual(Buffer.from(candidate, "utf8"), Buffer.from(key, "utf8"))) {
          foundKey = candidate;
          entry = pending.get(candidate);
        }
      }
      if (!entry) fail("github_state_invalid");
      pending.delete(foundKey); // single-use: any replay of the state fails
      if (entry.createdAt + ttlMs <= now()) fail("github_state_expired");
      return { codeVerifier: entry.codeVerifier, sessionToken: entry.sessionToken, sessionRevision: entry.sessionRevision,
        link: entry.link === true };
    }
  };
}

// Bounded JSON fetch mirroring google-oauth.mjs: 64 KiB cap, no redirects.
async function fetchJson(fetchFn, url, init, { providerError, invalidError, allowArray = false }) {
  let response;
  try {
    response = await fetchFn(url, { ...init, redirect: "error", signal: AbortSignal.timeout(15000) });
  } catch (error) {
    if (error instanceof GitHubOAuthError) throw error;
    fail("github_provider_unavailable");
  }
  if (!response.ok || !response.body) {
    try { await response.body?.cancel?.(); } catch { /* best effort: release a rejected body */ }
    fail(providerError);
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) { await reader.cancel(); fail(invalidError); }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof GitHubOAuthError) throw error;
    fail("github_provider_unavailable");
  }
  let data;
  try { data = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { fail(invalidError); }
  if (!data || typeof data !== "object" || (!allowArray && Array.isArray(data))) fail(invalidError);
  return data;
}

export async function exchangeCodeForToken({ code, codeVerifier, clientId, clientSecret, redirectUri, fetchFn = fetch }) {
  if (!opaque(code) || !opaque(clientId) || !opaque(clientSecret)) fail("github_configuration_invalid");
  if (typeof codeVerifier !== "string" || codeVerifier.length < 43 || codeVerifier.length > 128) fail("github_verifier_invalid");
  const data = await fetchJson(fetchFn, GITHUB_TOKEN_URL, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: clientId, client_secret: clientSecret, code, code_verifier: codeVerifier, redirect_uri: redirectUri
    }).toString()
  }, { providerError: "github_token_rejected", invalidError: "github_token_invalid" });
  // A provider-side refusal of the grant (bad/expired code, PKCE mismatch)
  // is distinct from a malformed token payload.
  if (typeof data.error === "string") fail("github_token_rejected");
  if (typeof data.access_token !== "string" || !opaque(data.access_token)) fail("github_token_invalid");
  if (typeof data.token_type === "string" && data.token_type.toLowerCase() !== "bearer") fail("github_token_invalid");
  return data.access_token;
}

// Reads the GitHub user and their emails. Only an email the provider marks
// primary AND verified is ever trusted for account linking — an unverified
// address yields null and the account is keyed on the numeric subject.
export async function fetchGitHubUser(accessToken, fetchFn = fetch) {
  if (!opaque(accessToken)) fail("github_token_invalid");
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${accessToken}`,
    "X-GitHub-Api-Version": "2022-11-28"
  };
  const user = await fetchJson(fetchFn, GITHUB_USER_URL, { method: "GET", headers },
    { providerError: "github_provider_rejected", invalidError: "github_user_invalid" });
  if (!Number.isSafeInteger(user.id) || user.id <= 0) fail("github_user_invalid");
  const login = typeof user.login === "string" && user.login.length > 0 ? user.login : null;
  const emails = await fetchJson(fetchFn, GITHUB_EMAILS_URL, { method: "GET", headers },
    { providerError: "github_provider_rejected", invalidError: "github_user_invalid", allowArray: true });
  if (!Array.isArray(emails)) fail("github_user_invalid");
  const primary = emails.find(entry => entry && entry.primary === true && entry.verified === true
    && typeof entry.email === "string" && entry.email.length > 0);
  const email = primary ? primary.email : null;
  return { id: user.id, login, email };
}

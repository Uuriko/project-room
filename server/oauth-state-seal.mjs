// Stateless OAuth state (RC-2026-09-19-076, QAX-003).
//
// OAuth pending PKCE/state used to live in a per-isolate in-memory Map, so
// any callback arriving after a server restart or isolate migration failed.
// Instead, the flow's server-side state is sealed with AES-256-GCM and
// carried through the `state` query param itself: the key is derived from
// the OAuth client secret via HKDF-SHA256, so unsealing needs no stored
// state at all — only the configured secret. Rotating the client secret
// rotates the key (in-flight flows, 10-minute TTL, simply fail closed and
// the user starts again).
//
// Single-use semantics are enforced provider-side: authorization codes are
// single-use at Google/GitHub, so a replayed callback re-exchanges an
// already-consumed code and the provider rejects the grant. The blob also
// binds the browser slot token, the session revision, the link intent, and
// the redirect URI it was issued for.
//
// Blob format: `os1.` + base64url(nonce(12) || tag(16) || ciphertext).
// The JSON payload is { v, provider, iat, exp, cv, st, rev, link, r }.

import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";

export const OAUTH_STATE_VERSION = "os1";
export const OAUTH_STATE_TTL_MS = 10 * 60 * 1000;
export const OAUTH_STATE_MAX_CHARS = 2048;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const statePattern = /^os1\.[A-Za-z0-9_-]{1,2044}$/;

export class OAuthStateError extends Error {
  // kind: "invalid" (malformed, forged, tampered, or bound-field mismatch)
  // or "expired" (past the TTL — the caller maps this to its own code).
  constructor(kind) {
    super(kind);
    this.name = "OAuthStateError";
    this.kind = kind;
  }
}

export function isSealedOAuthState(value) {
  return typeof value === "string" && statePattern.test(value);
}

function deriveKey(clientSecret, provider) {
  return hkdfSync("sha256", Buffer.from(clientSecret, "utf8"), "room-oauth-state-v1", `oauth-state:${provider}`, 32);
}

const fail = kind => { throw new OAuthStateError(kind); };

// Field validation shared by seal (programmer errors surface early) and
// unseal (a forged blob that decrypts but carries junk is invalid).
function checkPayload({ codeVerifier, slotToken, sessionRevision, link, redirectUri }) {
  if (typeof codeVerifier !== "string" || codeVerifier.length < 43 || codeVerifier.length > 128
    || !/^[A-Za-z0-9_-]+$/.test(codeVerifier)) return false;
  // Both providers bind the browser's account-session slot token.
  if (!/^[A-Za-z0-9_-]{43}$/.test(slotToken || "")) return false;
  if (!Number.isSafeInteger(sessionRevision) || sessionRevision < 0) return false;
  if (typeof link !== "boolean") return false;
  if (typeof redirectUri !== "string" || redirectUri.length === 0 || redirectUri.length > 1024) return false;
  return true;
}

export function sealOAuthState({ clientSecret, provider, codeVerifier, slotToken, sessionRevision,
  link = false, redirectUri, ttlMs = OAUTH_STATE_TTL_MS, now = Date.now } = {}) {
  if (typeof clientSecret !== "string" || clientSecret.length === 0 || clientSecret.length > 512) fail("invalid");
  if (typeof provider !== "string" || provider.length === 0 || provider.length > 32) fail("invalid");
  if (!checkPayload({ codeVerifier, slotToken, sessionRevision, link, redirectUri })) fail("invalid");
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 24 * 3600000) fail("invalid");
  const issuedAt = now();
  if (!Number.isSafeInteger(issuedAt) || issuedAt < 0) fail("invalid");
  const body = JSON.stringify({
    v: 1, provider, iat: issuedAt, exp: issuedAt + ttlMs,
    cv: codeVerifier, st: slotToken, rev: sessionRevision, link, r: redirectUri
  });
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv("aes-256-gcm", deriveKey(clientSecret, provider), nonce);
  const ciphertext = Buffer.concat([cipher.update(body, "utf8"), cipher.final()]);
  const blob = `${OAUTH_STATE_VERSION}.${Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString("base64url")}`;
  if (blob.length > OAUTH_STATE_MAX_CHARS) fail("invalid");
  return blob;
}

export function unsealOAuthState({ clientSecret, provider, state, redirectUri, now = Date.now } = {}) {
  if (typeof clientSecret !== "string" || clientSecret.length === 0
    || typeof provider !== "string" || provider.length === 0 || !isSealedOAuthState(state)) fail("invalid");
  const raw = Buffer.from(state.slice(OAUTH_STATE_VERSION.length + 1), "base64url");
  if (raw.length < NONCE_BYTES + TAG_BYTES + 1) fail("invalid");
  const nonce = raw.subarray(0, NONCE_BYTES);
  const tag = raw.subarray(NONCE_BYTES, NONCE_BYTES + TAG_BYTES);
  const ciphertext = raw.subarray(NONCE_BYTES + TAG_BYTES);
  let body;
  try {
    const decipher = createDecipheriv("aes-256-gcm", deriveKey(clientSecret, provider), nonce);
    decipher.setAuthTag(tag);
    body = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    // Wrong key (secret rotated or wrong provider account) or any tamper
    // fails the GCM auth tag — indistinguishable from a forged blob.
    fail("invalid");
  }
  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    fail("invalid");
  }
  // The blob is cryptographically authentic here, but the fields are still
  // untrusted: the provider label, redirect binding, and payload shapes
  // must all check out before the caller acts on them.
  if (!payload || typeof payload !== "object" || payload.v !== 1 || payload.provider !== provider) fail("invalid");
  if (typeof payload.r !== "string" || payload.r !== redirectUri) fail("invalid");
  const at = now();
  if (!Number.isSafeInteger(at) || at < 0) fail("invalid");
  if (!Number.isSafeInteger(payload.exp) || payload.exp <= at) fail("expired");
  if (!checkPayload({ codeVerifier: payload.cv, slotToken: payload.st, sessionRevision: payload.rev,
    link: payload.link, redirectUri: payload.r })) fail("invalid");
  return {
    codeVerifier: payload.cv, slotToken: payload.st, sessionRevision: payload.rev, link: payload.link,
    issuedAt: payload.iat, expiresAt: payload.exp
  };
}

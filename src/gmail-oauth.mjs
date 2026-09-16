// Gmail / Google OAuth 2.0 connection flow. Pure logic only:
//   - buildAuthorizeUrl: the user-facing authorization URL (PKCE + offline consent)
//   - buildTokenExchangeRequest: the authorization-code token exchange POST *shape*
//     (it is returned, never executed — the caller performs the HTTP call)
//   - parseTokenResponse: normalizes the token endpoint JSON into opaque refs;
//     raw token values are never retained in the returned shapes
//   - connectionRecord: the storage-ready connection record (refs only, no token values)
//   - scopesFor: purpose name -> Gmail scope URLs
//   - newPkcePair: PKCE verifier/challenge generation (RFC 7636, S256)
// No network calls, no secrets in code. Randomness and time come from an injected
// `deps = { random, clock }` parameter so tests stay deterministic:
//   random: (byteLength) => bytes (Buffer/Uint8Array)
//   clock:  () => epoch milliseconds (like Date.now)
import { randomBytes, createHash } from "node:crypto";

export const GOOGLE_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";

// Purpose names mapped to Gmail scope URLs. Pairs with the read adapter's
// scope handling; the record stores the resolved URLs, not the purpose names.
const PURPOSE_SCOPES = Object.freeze({
  "mail.read": ["https://www.googleapis.com/auth/gmail.readonly"],
  "mail.send": ["https://www.googleapis.com/auth/gmail.send"],
  "mail.compose": ["https://www.googleapis.com/auth/gmail.compose"],
});

export function scopesFor(purpose) {
  const scopes = PURPOSE_SCOPES[purpose];
  if (!scopes) throw oauthError("GMAIL_UNKNOWN_PURPOSE", `Unknown Gmail OAuth purpose: ${String(purpose)}`);
  return [...scopes];
}

export const OAUTH_PURPOSES = Object.freeze(Object.keys(PURPOSE_SCOPES));

function oauthError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

const defaultDeps = { random: bytes => randomBytes(bytes), clock: () => Date.now() };

function depsOf(deps = {}) {
  return {
    random: typeof deps.random === "function" ? deps.random : defaultDeps.random,
    clock: typeof deps.clock === "function" ? deps.clock : defaultDeps.clock,
  };
}

// Opaque reference: the ref travels to storage/logs, the raw value never does.
const refOf = (prefix, random, bytes = 16) =>
  `${prefix}_${Buffer.from(random(bytes)).toString("hex")}`;

// https required everywhere; plain http is tolerated only on loopback so local
// dev callbacks keep working.
function requireRedirectUri(redirectUri) {
  let url = null;
  try { url = new URL(String(redirectUri)); } catch { url = null; }
  const host = url?.hostname.toLowerCase();
  const loopback = host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
  const ok = !!url && (url.protocol === "https:" || (loopback && url.protocol === "http:"));
  if (!ok) throw oauthError("GMAIL_INVALID_REDIRECT",
    `redirectUri must be an https URL (http allowed for localhost only): ${String(redirectUri)}`);
  return url.toString();
}

function normalizeScopes(scopes) {
  const raw = Array.isArray(scopes) ? scopes : String(scopes ?? "").split(/\s+/);
  const list = [...new Set(raw.map(s => String(s).trim()).filter(Boolean))];
  if (list.length === 0) throw oauthError("GMAIL_EMPTY_SCOPES", "At least one OAuth scope is required");
  for (const scope of list) {
    if (!/^https:\/\/\S+$/.test(scope)) throw oauthError("GMAIL_INVALID_SCOPE", `Not a valid scope URL: ${scope}`);
  }
  return list;
}

function requireClientId(clientId) {
  if (typeof clientId !== "string" || !clientId.trim()) {
    throw oauthError("GMAIL_INVALID_CLIENT_ID", "clientId is required");
  }
  return clientId.trim();
}

// Full Google authorization URL. `state` is generated from injected randomness
// when omitted; pass `codeChallenge` from newPkcePair() for the PKCE step.
export function buildAuthorizeUrl(
  { clientId, redirectUri, scopes, state, codeChallenge, accessType = "offline", prompt = "consent" } = {},
  deps = {},
) {
  const id = requireClientId(clientId);
  const redirect = requireRedirectUri(redirectUri);
  const scopeList = normalizeScopes(scopes);
  const { random } = depsOf(deps);
  const params = new URLSearchParams({
    response_type: "code",
    client_id: id,
    redirect_uri: redirect,
    scope: scopeList.join(" "),
    access_type: accessType,
    prompt,
  });
  params.set("state", typeof state === "string" && state ? state : refOf("st", random));
  if (codeChallenge !== undefined && codeChallenge !== null && codeChallenge !== "") {
    params.set("code_challenge", String(codeChallenge));
    params.set("code_challenge_method", "S256");
  }
  return `${GOOGLE_AUTHORIZE_URL}?${params.toString()}`;
}

// Shape of the authorization-code exchange POST to the Google token endpoint.
// The request is returned for the caller to execute; this function performs no
// fetch. `clientSecretRef` is an opaque vault reference, never a raw secret —
// the caller resolves it before sending.
export function buildTokenExchangeRequest(
  { clientId, redirectUri, code, codeVerifier, clientSecretRef } = {},
) {
  const id = requireClientId(clientId);
  const redirect = requireRedirectUri(redirectUri);
  if (typeof code !== "string" || !code.trim()) throw oauthError("GMAIL_INVALID_CODE", "Authorization code is required");
  if (typeof codeVerifier !== "string" || !codeVerifier.trim()) {
    throw oauthError("GMAIL_INVALID_VERIFIER", "PKCE code_verifier is required");
  }
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: code.trim(),
    redirect_uri: redirect,
    client_id: id,
    code_verifier: codeVerifier.trim(),
  });
  if (clientSecretRef !== undefined && clientSecretRef !== null && clientSecretRef !== "") {
    body.set("client_secret", String(clientSecretRef));
  }
  return {
    url: GOOGLE_TOKEN_URL,
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  };
}

// Normalize the token endpoint JSON. Raw token values are converted to opaque
// refs at this boundary so nothing downstream can persist or log them.
// Google may omit refresh_token on re-consent: represented as
// refreshTokenRef: null plus needsReconsent: true when accessType was offline.
export function parseTokenResponse(json, { accessType = "offline" } = {}, deps = {}) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    throw oauthError("GMAIL_BAD_TOKEN_RESPONSE", "Token response must be a JSON object");
  }
  const { random, clock } = depsOf(deps);
  if (typeof json.access_token !== "string" || !json.access_token) {
    throw oauthError("GMAIL_BAD_TOKEN_RESPONSE", "Token response is missing access_token");
  }
  const expiresIn = Number(json.expires_in);
  if (!Number.isFinite(expiresIn) || expiresIn < 0) {
    throw oauthError("GMAIL_BAD_TOKEN_RESPONSE", "Token response has an invalid expires_in");
  }
  const hasRefresh = typeof json.refresh_token === "string" && json.refresh_token.length > 0;
  return {
    accessTokenRef: refOf("gat", random),
    refreshTokenRef: hasRefresh ? refOf("grt", random) : null,
    expiresAt: new Date(clock() + Math.floor(expiresIn) * 1000).toISOString(),
    scopesGranted: typeof json.scope === "string"
      ? json.scope.split(/\s+/).map(s => s.trim()).filter(Boolean)
      : [],
    tokenType: typeof json.token_type === "string" && json.token_type ? json.token_type : "Bearer",
    needsReconsent: accessType === "offline" && !hasRefresh,
  };
}

// Storage-ready connection record. Token values appear only as opaque refs;
// connectedAt comes from the injected clock.
export function connectionRecord(
  { accountId, scopesGranted, expiresAt = null, hasRefreshToken = false, accessTokenRef, refreshTokenRef } = {},
  deps = {},
) {
  if (typeof accountId !== "string" || !accountId.trim()) {
    throw oauthError("GMAIL_INVALID_ACCOUNT", "accountId is required");
  }
  const { clock } = depsOf(deps);
  const tokenMeta = {
    expiresAt: expiresAt ?? null,
    hasRefreshToken: hasRefreshToken === true,
  };
  if (accessTokenRef !== undefined && accessTokenRef !== null && accessTokenRef !== "") {
    tokenMeta.accessTokenRef = String(accessTokenRef);
  }
  if (refreshTokenRef !== undefined && refreshTokenRef !== null && refreshTokenRef !== "") {
    tokenMeta.refreshTokenRef = String(refreshTokenRef);
  }
  return {
    provider: "gmail",
    accountId: accountId.trim(),
    scopes: normalizeScopes(scopesGranted),
    status: "connected",
    connectedAt: new Date(clock()).toISOString(),
    tokenMeta,
  };
}

// RFC 7636 PKCE pair: 32 random bytes -> base64url verifier (43 chars, inside
// the 43..128 range), challenge = base64url(sha256(verifier)). Randomness is
// injected; bytes must be 32..96.
export function newPkcePair({ bytes = 32 } = {}, deps = {}) {
  if (!Number.isInteger(bytes) || bytes < 32 || bytes > 96) {
    throw oauthError("GMAIL_INVALID_PKCE", "PKCE entropy must be 32..96 bytes");
  }
  const { random } = depsOf(deps);
  const verifier = Buffer.from(random(bytes)).toString("base64url");
  const challenge = createHash("sha256").update(verifier, "ascii").digest("base64url");
  return { verifier, challenge };
}

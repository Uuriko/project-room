// OAuth2 authorization server for third-party connectors (e.g. Meta Muse).
//
// This is the PROVIDER side: external clients (like Muse) redirect users here
// to obtain scoped access tokens for the Project Room API. This is distinct
// from server/google-oauth.mjs and server/github-oauth.mjs, which are CLIENT
// implementations for user sign-in.
//
// Implements:
// - RFC 6749 authorization code flow with PKCE (S256 required)
// - RFC 7009 token revocation
// - RFC 8414 authorization server metadata (served by http.mjs)
//
// Scopes map to Project Room capabilities:
//   rooms:read   list and read rooms the user belongs to
//   chat:read    read messages
//   chat:write   post messages
//   work:read    read work items
//   work:write   accept and complete work
//
// Pure module: all state is caller-owned Maps, crypto is node:crypto,
// no network I/O. Frozen outputs; malformed inputs throw OAuthProviderError
// (coded errors). Token secrets are never stored — only SHA-256 hashes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

class OAuthProviderError extends Error {
  constructor(code, message) { super(message); this.name = "OAuthProviderError"; this.code = code; }
}
const fail = (code, message) => { throw new OAuthProviderError(code, message); };
const check = (condition, message) => { if (!condition) fail("invalid_request", message); };

// Valid scope strings for connector authorization.
export const OAUTH_SCOPES = Object.freeze([
  "rooms:read",
  "chat:read",
  "chat:write",
  "work:read",
  "work:write",
]);

const CLIENT_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SCOPE_PATTERN = /^[a-z0-9:_*-]+$/;
const CODE_CHALLENGE_PATTERN = /^[A-Za-z0-9_-]{43,128}$/;

const AUTH_CODE_TTL_MS = 10 * 60 * 1000;          // 10 minutes, single use
const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;       // 1 hour
const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

const sha256 = text => createHash("sha256").update(text).digest("hex");
const base64url = bytes => Buffer.from(bytes).toString("base64url");
const newSecret = (bytes = 32) => base64url(randomBytes(bytes));

const isExpired = (record, now) => record.expiresAt !== null && now() >= record.expiresAt;

export function createOAuthProvider({ clients, codes, accessTokens, refreshTokens, clock, onSecurityEvent } = {}) {
  check(clients === undefined || clients instanceof Map, "clients must be a Map if given");
  check(codes === undefined || codes instanceof Map, "codes must be a Map if given");
  check(accessTokens === undefined || accessTokens instanceof Map, "accessTokens must be a Map if given");
  check(refreshTokens === undefined || refreshTokens instanceof Map, "refreshTokens must be a Map if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  check(onSecurityEvent === undefined || typeof onSecurityEvent === "function",
    "onSecurityEvent must be a function if given");

  const clientStore = clients ?? new Map();
  const codeStore = codes ?? new Map();
  const accessStore = accessTokens ?? new Map();
  const refreshStore = refreshTokens ?? new Map();
  const now = clock ?? Date.now;
  // Caller-owned sink for security signals (e.g. reuse-detected). The module
  // itself does no I/O; the HTTP layer wires this to its logging/journaling.
  const emitSecurityEvent = onSecurityEvent ?? (() => {});

  // Register an OAuth client (e.g. Muse). redirectUris must be exact-match
  // https URIs (http allowed only for localhost, per RFC 6749 §3.1.2.1).
  const registerClient = ({ clientId, name, redirectUris }) => {
    check(typeof clientId === "string" && CLIENT_ID_PATTERN.test(clientId),
      "clientId must match [A-Za-z0-9_-]{1,64}");
    check(typeof name === "string" && name.length > 0 && name.length <= 80,
      "name must be a non-empty string up to 80 chars");
    check(Array.isArray(redirectUris) && redirectUris.length > 0,
      "redirectUris must be a non-empty array");
    for (const uri of redirectUris) {
      check(typeof uri === "string", "every redirectUri must be a string");
      let parsed;
      try { parsed = new URL(uri); } catch { fail("invalid_request", `redirectUri is not a URL: ${uri}`); }
      const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      check(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalhost),
        "redirectUri must be https (http allowed only for localhost)");
      check(!parsed.hash, "redirectUri must not contain a fragment");
    }
    check(!clientStore.has(clientId), `client "${clientId}" is already registered`);
    const client = { clientId, name, redirectUris: Object.freeze([...redirectUris]) };
    clientStore.set(clientId, client);
    return Object.freeze({ ...client });
  };

  const getClient = clientId => {
    const client = clientStore.get(clientId);
    return client ? Object.freeze({ ...client, redirectUris: Object.freeze([...client.redirectUris]) }) : null;
  };

  const validateScopes = scopes => {
    check(Array.isArray(scopes) && scopes.length > 0, "scopes must be a non-empty array");
    check(scopes.every(s => typeof s === "string" && SCOPE_PATTERN.test(s)),
      "every scope must be a lowercase scope string");
    const unknown = scopes.filter(s => !OAUTH_SCOPES.includes(s));
    check(unknown.length === 0, `unknown scopes: ${unknown.join(", ")}`);
    return Object.freeze([...new Set(scopes)]);
  };

  // Step 1: validate an authorization request. Returns the validated request
  // for the consent screen; throws on invalid client/redirect/scope.
  const validateAuthorizationRequest = ({ clientId, redirectUri, scopes, state, codeChallenge }) => {
    check(typeof clientId === "string" && clientId.length > 0, "client_id is required");
    const client = clientStore.get(clientId);
    check(client, "unknown client_id");
    check(typeof redirectUri === "string" && client.redirectUris.includes(redirectUri),
      "redirect_uri must exactly match a registered redirect URI");
    const validScopes = validateScopes(scopes);
    // state is optional per RFC but recommended; pass through opaque.
    check(state === undefined || (typeof state === "string" && state.length <= 1024),
      "state must be a string up to 1024 chars if given");
    check(typeof codeChallenge === "string" && CODE_CHALLENGE_PATTERN.test(codeChallenge),
      "code_challenge (PKCE S256) is required");
    return Object.freeze({ client, redirectUri, scopes: validScopes, state: state ?? null, codeChallenge });
  };

  // Step 2: after the user approves, issue an authorization code.
  const issueCode = ({ clientId, userId, redirectUri, scopes, codeChallenge }) => {
    check(typeof userId === "string" && userId.length > 0 && userId.length <= 128,
      "userId must be a non-empty string up to 128 chars");
    const validated = validateAuthorizationRequest({ clientId, redirectUri, scopes, codeChallenge });
    const code = `oac_${newSecret(24)}`;
    const record = {
      codeHash: sha256(code),
      clientId: validated.client.clientId,
      userId,
      redirectUri: validated.redirectUri,
      scopes: validated.scopes,
      codeChallenge: validated.codeChallenge,
      createdAt: now(),
      expiresAt: now() + AUTH_CODE_TTL_MS,
      used: false,
    };
    codeStore.set(record.codeHash, record);
    return Object.freeze({ code, expiresAt: record.expiresAt });
  };

  // Step 3: exchange an authorization code for tokens. Verifies PKCE.
  const exchangeCode = ({ code, clientId, redirectUri, codeVerifier, session }) => {
    check(typeof code === "string" && code.length > 0, "code is required");
    check(typeof clientId === "string" && clientId.length > 0, "client_id is required");
    check(typeof redirectUri === "string" && redirectUri.length > 0, "redirect_uri is required");
    check(typeof codeVerifier === "string" && codeVerifier.length >= 43 && codeVerifier.length <= 128,
      "code_verifier is required");
    const record = codeStore.get(sha256(code));
    check(record, "invalid authorization code");
    check(!record.used, "authorization code already used");
    check(!isExpired(record, now), "authorization code expired");
    check(record.clientId === clientId, "client_id mismatch");
    check(record.redirectUri === redirectUri, "redirect_uri mismatch");
    // PKCE S256 verification.
    const expected = base64url(createHash("sha256").update(codeVerifier).digest());
    const a = Buffer.from(expected);
    const b = Buffer.from(record.codeChallenge);
    check(a.length === b.length && timingSafeEqual(a, b), "PKCE verification failed");
    record.used = true;

    return issueTokenPair({ clientId: record.clientId, userId: record.userId, scopes: [...record.scopes], session });
  };

  // Session metadata attached at issuance (F-02): the IP and User-Agent
  // seen when the grant was created or refreshed, surfaced read-only by
  // listSessions so the user can recognize their own sessions. Coerced,
  // never thrown on — a missing or malformed meta degrades to nulls.
  const normalizeSessionMeta = session => {
    if (session == null) return { ip: null, userAgent: null };
    check(typeof session === "object", "session must be an object if given");
    const str = (value, max) =>
      typeof value === "string" && value.length > 0 ? value.slice(0, max) : null;
    return { ip: str(session.ip, 64), userAgent: str(session.userAgent, 256) };
  };

  // Every access+refresh pair minted from one grant shares a familyId.
  // Rotation carries the familyId forward; reuse of a rotated refresh token
  // (record.rotatedBy set) then revokes the whole family (F-01).
  const issueTokenPair = ({ clientId, userId, scopes, familyId = `oarf_${newSecret(16)}`, session } = {}) => {
    const validScopes = validateScopes(scopes);
    const accessToken = `oat_${newSecret()}`;
    const refreshToken = `oar_${newSecret()}`;
    const at = now();
    const meta = normalizeSessionMeta(session);
    accessStore.set(sha256(accessToken), {
      tokenHash: sha256(accessToken),
      clientId, userId, scopes: validScopes, familyId,
      createdAt: at, expiresAt: at + ACCESS_TOKEN_TTL_MS, revoked: false,
      ip: meta.ip, userAgent: meta.userAgent,
    });
    refreshStore.set(sha256(refreshToken), {
      tokenHash: sha256(refreshToken),
      clientId, userId, scopes: validScopes, familyId,
      createdAt: at, expiresAt: at + REFRESH_TOKEN_TTL_MS, revoked: false,
      rotatedBy: null, // hash of the refresh token that superseded this one
      ip: meta.ip, userAgent: meta.userAgent,
    });
    return Object.freeze({
      accessToken, refreshToken,
      tokenType: "Bearer",
      expiresIn: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
      scopes: validScopes,
    });
  };

  // Revoke every access and refresh token derived from the same original
  // grant. Returns the number of tokens newly revoked.
  const revokeTokenFamily = familyId => {
    let count = 0;
    for (const record of refreshStore.values()) {
      if (record.familyId === familyId && !record.revoked) { record.revoked = true; count++; }
    }
    for (const record of accessStore.values()) {
      if (record.familyId === familyId && !record.revoked) { record.revoked = true; count++; }
    }
    return count;
  };

  // Refresh an access token. Rotates the refresh token (old one revoked).
  // Reuse of a rotated (superseded) refresh token signals theft
  // (OAuth Security BCP §4.12 / RFC 6749 §6): the whole token family is
  // revoked and the caller gets a distinct invalid_grant so the legitimate
  // user sees a theft signal instead of a silent "revoked".
  const refresh = ({ refreshToken, clientId, session }) => {
    check(typeof refreshToken === "string" && refreshToken.length > 0, "refresh_token is required");
    check(typeof clientId === "string" && clientId.length > 0, "client_id is required");
    const record = refreshStore.get(sha256(refreshToken));
    check(record, "invalid refresh token");
    if (record.revoked && record.rotatedBy) {
      const revokedCount = revokeTokenFamily(record.familyId);
      emitSecurityEvent({
        type: "refresh_token_reuse_detected",
        familyId: record.familyId,
        userId: record.userId,
        clientId: record.clientId,
        revokedCount,
        detectedAt: now(),
      });
      fail("invalid_grant", "refresh token reuse detected: token family revoked");
    }
    check(!record.revoked, "refresh token revoked");
    check(!isExpired(record, now), "refresh token expired");
    check(record.clientId === clientId, "client_id mismatch");
    record.revoked = true; // rotation: old refresh token is single-use
    const next = issueTokenPair({
      clientId: record.clientId, userId: record.userId,
      scopes: [...record.scopes], familyId: record.familyId, session,
    });
    record.rotatedBy = sha256(next.refreshToken);
    return next;
  };

  // Verify a bearer access token. Returns { userId, clientId, scopes } or null.
  const verifyAccessToken = token => {
    check(typeof token === "string" && token.length > 0, "token must be a non-empty string");
    const record = accessStore.get(sha256(token));
    if (!record || record.revoked || isExpired(record, now)) return null;
    return Object.freeze({
      userId: record.userId,
      clientId: record.clientId,
      scopes: Object.freeze([...record.scopes]),
    });
  };

  // RFC 7009 revocation: revoke an access or refresh token. Revoking a
  // refresh token kills its whole token family (F-02): every access token
  // derived from the grant dies immediately instead of lingering to its
  // 1-hour TTL, which is what the consent screen promises ("revoke access
  // at any time"). Revoking an access token stays surgical — only that
  // token dies. Rotation never calls this (it flips the single record's
  // flag directly), so a routine refresh does not nuke the family.
  const revoke = token => {
    check(typeof token === "string" && token.length > 0, "token must be a non-empty string");
    const digest = sha256(token);
    const at = accessStore.get(digest);
    if (at) { at.revoked = true; return true; }
    const rt = refreshStore.get(digest);
    if (rt) { revokeTokenFamily(rt.familyId); return true; }
    return false; // RFC 7009: invalid tokens still return success
  };

  // Revoke all tokens for a user (disconnect). clientId narrows to one
  // client; omit it to kill every session the user holds (F-02).
  const revokeAllForUser = ({ userId, clientId } = {}) => {
    check(typeof userId === "string" && userId.length > 0, "userId is required");
    check(clientId === undefined || (typeof clientId === "string" && clientId.length > 0),
      "clientId must be a non-empty string if given");
    let count = 0;
    for (const record of accessStore.values()) {
      if (record.userId === userId && (clientId === undefined || record.clientId === clientId) && !record.revoked) {
        record.revoked = true; count++;
      }
    }
    for (const record of refreshStore.values()) {
      if (record.userId === userId && (clientId === undefined || record.clientId === clientId) && !record.revoked) {
        record.revoked = true; count++;
      }
    }
    return count;
  };

  // F-02 session inventory: the user's live token families. A family only
  // appears while it still holds a non-revoked, non-expired token; fully
  // revoked or expired families drop out on their own. The IP/User-Agent
  // shown is the newest record's — issuance-time metadata, read-only.
  const listSessions = ({ userId } = {}) => {
    check(typeof userId === "string" && userId.length > 0, "userId is required");
    const families = new Map();
    const fold = (record, kind) => {
      if (record.userId !== userId || record.revoked || isExpired(record, now)) return;
      let agg = families.get(record.familyId);
      if (!agg) {
        agg = { id: record.familyId, clientId: record.clientId, issuedAt: record.createdAt,
          scopes: [], ip: null, userAgent: null, newestAt: -1, accessTokens: 0, refreshTokens: 0 };
        families.set(record.familyId, agg);
      }
      if (record.createdAt < agg.issuedAt) agg.issuedAt = record.createdAt;
      if (record.createdAt >= agg.newestAt) {
        agg.newestAt = record.createdAt;
        agg.ip = record.ip ?? null;
        agg.userAgent = record.userAgent ?? null;
      }
      for (const scope of record.scopes) if (!agg.scopes.includes(scope)) agg.scopes.push(scope);
      if (kind === "access") agg.accessTokens++; else agg.refreshTokens++;
    };
    for (const record of accessStore.values()) fold(record, "access");
    for (const record of refreshStore.values()) fold(record, "refresh");
    return [...families.values()]
      .map(({ newestAt, ...rest }) => Object.freeze({ ...rest, scopes: Object.freeze(rest.scopes) }))
      .sort((a, b) => b.issuedAt - a.issuedAt);
  };

  // F-02 single-session kill: revoke the whole family, but only when it
  // belongs to the caller. Returns the number of tokens newly revoked; 0
  // when the family is unknown, fully revoked, or belongs to someone else —
  // the HTTP layer answers 404 without distinguishing those cases, so a
  // caller can't probe for other users' sessions.
  const revokeSession = ({ userId, familyId } = {}) => {
    check(typeof userId === "string" && userId.length > 0, "userId is required");
    check(typeof familyId === "string" && familyId.length > 0 && familyId.length <= 128,
      "familyId must be a non-empty string up to 128 chars");
    let count = 0;
    for (const record of accessStore.values()) {
      if (record.familyId === familyId && record.userId === userId && !record.revoked) {
        record.revoked = true; count++;
      }
    }
    for (const record of refreshStore.values()) {
      if (record.familyId === familyId && record.userId === userId && !record.revoked) {
        record.revoked = true; count++;
      }
    }
    return count;
  };

  // Scope check with prefix wildcards ("chat:*"), mirroring token-scopes.
  const grants = (token, requiredScope) => {
    const auth = verifyAccessToken(token);
    if (!auth) return false;
    return auth.scopes.some(scope => {
      if (scope === requiredScope) return true;
      if (scope.endsWith(":*")) return requiredScope.startsWith(scope.slice(0, -1));
      return false;
    });
  };

  return Object.freeze({
    registerClient,
    getClient,
    validateAuthorizationRequest,
    issueCode,
    exchangeCode,
    refresh,
    verifyAccessToken,
    revoke,
    revokeAllForUser,
    listSessions,
    revokeSession,
    grants,
    OAUTH_SCOPES,
  });
}
export { OAuthProviderError };

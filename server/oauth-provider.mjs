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
// - RFC 7591 dynamic client registration (registerDynamicClient;
//   http.mjs serves the door and the RFC 9728 metadata that points to it)
//
// Scopes map to Project Room capabilities:
//   rooms:read   list and read rooms the user belongs to
//   chat:read    read messages
//   chat:write   post messages
//   work:read    read work items
//   work:write   accept and complete work
//
// State lives in caller-owned Maps, or in SQLite when `db` is passed (the
// Durable Object). Crypto is node:crypto. No network I/O. Frozen outputs;
// malformed inputs throw OAuthProviderError (coded errors). Token secrets are
// never stored — only SHA-256 hashes.
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createOAuthProviderSqlite } from "./oauth-provider-store.mjs";

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
const CLIENT_TTL_MS = REFRESH_TOKEN_TTL_MS;

const sha256 = text => createHash("sha256").update(text).digest("hex");
const base64url = bytes => Buffer.from(bytes).toString("base64url");
const newSecret = (bytes = 32) => base64url(randomBytes(bytes));

const isExpired = (record, now) => record.expiresAt !== null && now() >= record.expiresAt;

// CURE-4445-SCOPE: the normal form for the reserved client-name
// comparison in registerDynamicClient. One function, applied to BOTH
// sides (candidate and provisioned names), so a provisioned name can
// never become unmatchable by its own normalisation:
//   1. NFKC — folds compatibility forms (fullwidth ＣｈａｔＧＰＴ reads
//      as ChatGPT) and composes decomposed accents (Cafe + U+0301
//      reads as Café) without stripping legitimate letters;
//   2. strip Unicode format characters (category Cf — zero-width
//      space/joiners, bidi controls, soft hyphen, tag characters) and
//      the remaining default-ignorable code points (combining grapheme
//      joiner U+034F, the Hangul fillers, Khmer inherent marks,
//      variation selectors), so "ChatGPT" + U+200B reads as "ChatGPT";
//   3. fold Cyrillic/Greek letters that are visual confusables of
//      Latin letters (UTS #39 confusables) to the Latin letter, so a
//      homoglyph "СhatGPT" (Cyrillic Es) reads as "ChatGPT" — NFKC
//      alone folds none of these;
//   4. the pre-cure trim + lowercase.
// The form is comparison-only: names are stored exactly as given.
const NAME_IGNORABLE_PATTERN =
  /[\p{Cf}\u034F\u115F\u1160\u17B4\u17B5\u3164\uFE00-\uFE0F\uFFA0\u{E0100}-\u{E01EF}]/gu;
const NAME_CONFUSABLES = new Map([
  // Cyrillic lookalikes of Latin letters.
  ["А", "A"], ["а", "a"], ["В", "B"], ["Е", "E"], ["е", "e"],
  ["К", "K"], ["к", "k"], ["М", "M"], ["м", "m"], ["Н", "H"],
  ["н", "h"], ["О", "O"], ["о", "o"], ["Р", "P"], ["р", "p"],
  ["С", "C"], ["с", "c"], ["Т", "T"], ["т", "t"], ["У", "Y"],
  ["у", "y"], ["Х", "X"], ["х", "x"], ["і", "i"], ["ј", "j"],
  ["ѕ", "s"], ["һ", "h"], ["ԁ", "d"],
  // Greek lookalikes of Latin letters.
  ["Α", "A"], ["Β", "B"], ["Ε", "E"], ["Ζ", "Z"], ["Η", "H"],
  ["Ι", "I"], ["Κ", "K"], ["Μ", "M"], ["Ν", "N"], ["Ο", "O"],
  ["Ρ", "P"], ["Τ", "T"], ["Χ", "X"], ["α", "a"], ["ι", "i"],
  ["κ", "k"], ["μ", "u"], ["ν", "v"], ["ο", "o"], ["ρ", "p"],
  ["χ", "x"],
]);
const clientNameNormalForm = value => {
  let folded = "";
  for (const ch of value.normalize("NFKC").replace(NAME_IGNORABLE_PATTERN, "")) {
    folded += NAME_CONFUSABLES.get(ch) ?? ch;
  }
  return folded.trim().toLowerCase();
};

export function createOAuthProvider({ clients, codes, accessTokens, refreshTokens, db, clock, onSecurityEvent, isAccountActive, resolveGrantAgent } = {}) {
  check(db === undefined || (clients === undefined && codes === undefined && accessTokens === undefined && refreshTokens === undefined),
    "sqlite storage replaces the in-memory maps");
  check(clients === undefined || clients instanceof Map, "clients must be a Map if given");
  check(codes === undefined || codes instanceof Map, "codes must be a Map if given");
  check(accessTokens === undefined || accessTokens instanceof Map, "accessTokens must be a Map if given");
  check(refreshTokens === undefined || refreshTokens instanceof Map, "refreshTokens must be a Map if given");
  check(db === undefined || typeof db?.prepare === "function", "db must be a SQLite database if given");
  check(clock === undefined || typeof clock === "function", "clock must be a function if given");
  check(onSecurityEvent === undefined || typeof onSecurityEvent === "function",
    "onSecurityEvent must be a function if given");
  check(isAccountActive === undefined || typeof isAccountActive === "function",
    "isAccountActive must be a function if given");
  check(resolveGrantAgent === undefined || typeof resolveGrantAgent === "function",
    "resolveGrantAgent must be a function if given");

  const sqlite = db ? createOAuthProviderSqlite(db) : null;
  const clientStore = clients ?? sqlite?.clients ?? new Map();
  const codeStore = codes ?? sqlite?.codes ?? new Map();
  const accessStore = accessTokens ?? sqlite?.accessTokens ?? new Map();
  const refreshStore = refreshTokens ?? sqlite?.refreshTokens ?? new Map();
  const now = clock ?? Date.now;
  const pruneLazy = () => { if (sqlite) sqlite.prune(now(), 32); };
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
    const existing = clientStore.get(clientId);
    if (existing && !isExpired(existing, now)) {
      const sameName = existing.name === name;
      const sameUris = existing.redirectUris.length === redirectUris.length
        && existing.redirectUris.every((uri, index) => uri === redirectUris[index]);
      check(sameName && sameUris, `client "${clientId}" is already registered`);
      existing.expiresAt = now() + CLIENT_TTL_MS;
      clientStore.set(clientId, existing);
      return Object.freeze({ clientId, name, redirectUris: Object.freeze([...redirectUris]) });
    }
    if (existing) clientStore.delete(clientId);
    const client = { clientId, name, redirectUris: Object.freeze([...redirectUris]), expiresAt: now() + CLIENT_TTL_MS };
    clientStore.set(clientId, client);
    return Object.freeze({ clientId, name, redirectUris: Object.freeze([...redirectUris]) });
  };

  // AGENT-DOOR-AUTH stage 3 (RFC 7591): dynamic client registration.
  // The server mints the client_id (public door: no client-proposed ids),
  // always under the `dcr_` prefix, so a dynamic registration can never
  // hand out — or collide with — a provisioned client's id (a provisioned
  // first-party client keeps its own principal treatment at approval).
  // Dynamic clients inherit the provisioned-client TTL exactly: 30 days,
  // refreshed when an identical registration (same name + same redirect
  // URIs, order-sensitive like registerClient) arrives while the client
  // is live — the repeat registration returns the same client instead of
  // minting a duplicate. Validation failures carry the RFC 7591 error
  // names; the HTTP door maps them verbatim.
  // CURE-4445-DCR: a provisioned client's name is reserved here (the
  // public door must not mint a look-alike of a connector the operator
  // provisioned), and the accepted scope set is stored on the record.
  const DYNAMIC_CLIENT_PREFIX = "dcr_";
  const registerDynamicClient = ({ name, redirectUris, scopes } = {}) => {
    const invalidMetadata = message => fail("invalid_client_metadata", message);
    if (typeof name !== "string" || name.length === 0 || name.length > 80) {
      invalidMetadata("client_name must be a non-empty string up to 80 chars");
    }
    if (!Array.isArray(redirectUris) || redirectUris.length === 0) {
      invalidMetadata("redirect_uris must be a non-empty array");
    }
    for (const uri of redirectUris) {
      if (typeof uri !== "string") invalidMetadata("every redirect_uri must be a string");
      let parsed;
      try { parsed = new URL(uri); } catch { fail("invalid_redirect_uri", `redirect_uri is not a URL: ${uri}`); }
      const isLocalhost = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
      if (!(parsed.protocol === "https:" || (parsed.protocol === "http:" && isLocalhost))) {
        fail("invalid_redirect_uri", "redirect_uri must be https (http allowed only for localhost)");
      }
      if (parsed.hash) fail("invalid_redirect_uri", "redirect_uri must not contain a fragment");
    }
    // CURE-4445-DCR (P2): the accepted scopes are stored on the client
    // record — until now the door echoed the requested set in the
    // registration response while nothing stored it. What is stored (and
    // reported) is the intersection with the server's requestable set:
    // unsupported scopes are dropped, and a request carrying nothing
    // requestable refuses, exactly as the door refused unknown scopes
    // before. No scopes argument means the full requestable set.
    let storedScopes;
    if (scopes === undefined) {
      storedScopes = [...OAUTH_SCOPES];
    } else {
      if (!Array.isArray(scopes) || !scopes.every(s => typeof s === "string")) {
        invalidMetadata("scope must be an array of scope strings");
      }
      storedScopes = [...new Set(scopes.filter(s => OAUTH_SCOPES.includes(s)))];
      if (storedScopes.length === 0) {
        invalidMetadata("scope must include at least one scope this server supports");
      }
    }
    // CURE-4445-DCR (P1): a provisioned client's name is reserved at this
    // public door. The reserved set is derived from the registry itself —
    // every live-or-dormant record whose id the dynamic door did not mint
    // (no `dcr_` prefix) is a provisioned client, registered by the
    // operator through registerClient — so the set can never drift from
    // the provisioned registry the way a hand-typed list would. Matching
    // is on the CURE-4445-SCOPE normal form (clientNameNormalForm:
    // NFKC + ignorable-stripped + confusable-folded + trim/lowercase),
    // applied to both sides. The check runs over the whole registry
    // before any identical-re-registration is honoured, so a pre-cure
    // copycat record cannot refresh its way past the reservation.
    const normalizeName = clientNameNormalForm;
    const wantedName = normalizeName(name);
    if (wantedName.length === 0) {
      invalidMetadata("client_name is empty once formatting and ignorable characters are removed");
    }
    let identical = null;
    if (typeof clientStore.values === "function") {
      for (const existing of clientStore.values()) {
        if (!existing || typeof existing.clientId !== "string") continue;
        if (!existing.clientId.startsWith(DYNAMIC_CLIENT_PREFIX)) {
          if (typeof existing.name === "string" && normalizeName(existing.name) === wantedName) {
            invalidMetadata("client_name matches a provisioned client; that name is reserved");
          }
          continue;
        }
        if (isExpired(existing, now)) continue;
        const sameName = existing.name === name;
        const sameUris = existing.redirectUris.length === redirectUris.length
          && existing.redirectUris.every((uri, index) => uri === redirectUris[index]);
        if (sameName && sameUris) identical = existing;
      }
    }
    if (identical) {
      const issuedAt = identical.issuedAt ?? (identical.expiresAt - CLIENT_TTL_MS);
      identical.expiresAt = now() + CLIENT_TTL_MS;
      // A refresh with an explicit scope set replaces the stored set;
      // without one the stored set (or the full set, for a pre-cure
      // record that has none) stands.
      identical.scopes = scopes === undefined
        ? (Array.isArray(identical.scopes) ? identical.scopes : [...OAUTH_SCOPES])
        : [...storedScopes];
      clientStore.set(identical.clientId, identical);
      return Object.freeze({
        clientId: identical.clientId, name, redirectUris: Object.freeze([...redirectUris]), issuedAt,
        scopes: Object.freeze([...identical.scopes]),
      });
    }
    let clientId;
    do { clientId = DYNAMIC_CLIENT_PREFIX + newSecret(18); } while (clientStore.get(clientId));
    const issuedAt = now();
    const client = {
      clientId, name, redirectUris: Object.freeze([...redirectUris]),
      expiresAt: issuedAt + CLIENT_TTL_MS, issuedAt, scopes: Object.freeze([...storedScopes]),
    };
    clientStore.set(clientId, client);
    return Object.freeze({
      clientId, name, redirectUris: client.redirectUris, issuedAt,
      scopes: Object.freeze([...storedScopes]),
    });
  };

  const getClient = clientId => {
    const client = clientStore.get(clientId);
    if (!client) return null;
    if (isExpired(client, now)) { clientStore.delete(clientId); return null; }
    return Object.freeze({
      clientId: client.clientId, name: client.name, redirectUris: Object.freeze([...client.redirectUris]),
      // The scope set stored at registration (dynamic clients); null for
      // provisioned clients, which carry no per-client scope set.
      scopes: Array.isArray(client.scopes) ? Object.freeze([...client.scopes]) : null,
    });
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
    const client = getClient(clientId);
    check(client, "unknown client_id");
    check(typeof redirectUri === "string" && client.redirectUris.includes(redirectUri),
      "redirect_uri must exactly match a registered redirect URI");
    const validScopes = validateScopes(scopes);
    // CURE-4445-SCOPE: a client with a stored registration set — the
    // dynamic (dcr_) clients whose accepted scopes CURE-4445-DCR stored
    // on the record; getClient returns null scopes for provisioned
    // clients, which keep the pre-cure behaviour exactly — may not be
    // authorized beyond that set. The cap is enforced here, at
    // validation, so the consent screen only ever lists within-set
    // scopes, and the code -> token -> refresh chain (which only ever
    // carries the validated/record scopes forward) has no widening
    // path around the consent screen.
    if (Array.isArray(client.scopes)) {
      const beyond = validScopes.filter(scope => !client.scopes.includes(scope));
      if (beyond.length > 0) {
        fail("invalid_scope", `scopes beyond this client's registered set: ${beyond.join(", ")}`);
      }
    }
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
    // AGENT-DOOR-AUTH stage 2: the grant's principal is decided at approval
    // time by the injected resolver. A connector grant acts as a separate
    // agent member the approving human owns (the resolver returns its
    // identity id); a resolver may instead mark a first-party client as
    // account-principal. With no resolver wired the stamp stays null —
    // legacy grants the resource doors fail closed rather than letting
    // them act as the human. A wired resolver that cannot bind fails the
    // approval itself.
    let agentIdentityId = null;
    let principal = null;
    if (typeof resolveGrantAgent === "function") {
      const resolved = resolveGrantAgent({
        userId, clientId: validated.client.clientId, clientName: validated.client.name,
      });
      if (resolved?.accountPrincipal === true) {
        principal = "account";
      } else if (typeof resolved?.agentIdentityId === "string" && resolved.agentIdentityId.length > 0) {
        principal = "agent";
        agentIdentityId = resolved.agentIdentityId;
      } else {
        fail("invalid_request", "grant could not be bound to a principal");
      }
    }
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
      agentIdentityId,
      principal,
      // O1 (issue #941): the family minted from this code, recorded at
      // exchange so a replayed code revokes its tokens (RFC 6749 §10.5).
      familyId: null,
    };
    codeStore.set(record.codeHash, record);
    pruneLazy();
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
    if (record.used) {
      // O1 (issue #941): a replayed code points to a leaked code
      // (RFC 6749 §10.5) — kill every token the code already issued and
      // signal it, instead of only rejecting the replay. invalid_grant
      // (not invalid_request) so a legitimate client sees a theft-grade
      // signal, matching the refresh-reuse response shape.
      if (record.familyId) {
        const revokedCount = revokeTokenFamily(record.familyId);
        emitSecurityEvent({
          type: "authorization_code_reuse_detected",
          familyId: record.familyId,
          userId: record.userId,
          clientId: record.clientId,
          revokedCount,
          detectedAt: now(),
        });
      }
      fail("invalid_grant", "authorization code already used: tokens issued from it were revoked");
    }
    if (isExpired(record, now)) { codeStore.delete(record.codeHash); fail("invalid_request", "authorization code expired"); }
    check(record.clientId === clientId, "client_id mismatch");
    check(record.redirectUri === redirectUri, "redirect_uri mismatch");
    // PKCE S256 verification.
    const expected = base64url(createHash("sha256").update(codeVerifier).digest());
    const a = Buffer.from(expected);
    const b = Buffer.from(record.codeChallenge);
    check(a.length === b.length && timingSafeEqual(a, b), "PKCE verification failed");
    // Bind the minted family to the code record BEFORE issuing, so the
    // linkage survives even if the issuer throws after this point.
    const familyId = `oarf_${newSecret(16)}`;
    record.familyId = familyId;
    record.used = true;

    return issueTokenPair({
      clientId: record.clientId, userId: record.userId, scopes: [...record.scopes], familyId, session,
      agentIdentityId: record.agentIdentityId ?? null, principal: record.principal ?? null,
    });
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
  const issueTokenPair = ({ clientId, userId, scopes, familyId = `oarf_${newSecret(16)}`, session, agentIdentityId = null, principal = null } = {}) => {
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
      agentIdentityId, principal,
    });
    refreshStore.set(sha256(refreshToken), {
      tokenHash: sha256(refreshToken),
      clientId, userId, scopes: validScopes, familyId,
      createdAt: at, expiresAt: at + REFRESH_TOKEN_TTL_MS, revoked: false,
      rotatedBy: null, // hash of the refresh token that superseded this one
      ip: meta.ip, userAgent: meta.userAgent,
      agentIdentityId, principal,
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
    if (isExpired(record, now)) { refreshStore.delete(record.tokenHash); fail("invalid_request", "refresh token expired"); }
    if (isAccountActive && !isAccountActive(record.userId)) fail("invalid_grant", "account is no longer active");
    check(record.clientId === clientId, "client_id mismatch");
    // Issue the replacement pair BEFORE revoking the old token (#2944).
    // issueTokenPair can still throw (validateScopes, or
    // normalizeSessionMeta for a non-object session); revoking first would
    // persist immediately on the SQLite store (and by reference on Map
    // stores), consuming the old token with no replacement issued. Issuing
    // first is safe: those throws happen before issueTokenPair writes any
    // new record, and this function is synchronous, so nothing can observe
    // both refresh tokens live in between.
    // Stage 2: the family's principal carries forward across rotation. A
    // pre-stage-2 family (principal stamp null) is bound once here through
    // the wired resolver — the migration path for grants approved before
    // stage 2 shipped; an unwired provider leaves it null and the doors
    // keep failing it closed.
    let agentIdentityId = record.agentIdentityId ?? null;
    let principal = record.principal ?? null;
    if (principal === null && typeof resolveGrantAgent === "function") {
      const resolved = resolveGrantAgent({
        userId: record.userId, clientId: record.clientId,
        clientName: getClient(record.clientId)?.name ?? record.clientId,
      });
      if (resolved?.accountPrincipal === true) {
        principal = "account";
        agentIdentityId = null;
      } else if (typeof resolved?.agentIdentityId === "string" && resolved.agentIdentityId.length > 0) {
        principal = "agent";
        agentIdentityId = resolved.agentIdentityId;
      }
    }
    const next = issueTokenPair({
      clientId: record.clientId, userId: record.userId,
      scopes: [...record.scopes], familyId: record.familyId, session,
      agentIdentityId, principal,
    });
    record.revoked = true; // rotation: old refresh token is single-use
    record.rotatedBy = sha256(next.refreshToken);
    return next;
  };

  // Verify a bearer access token. Returns { userId, clientId, scopes } or null.
  const verifyAccessToken = token => {
    check(typeof token === "string" && token.length > 0, "token must be a non-empty string");
    const digest = sha256(token);
    const record = accessStore.get(digest);
    if (!record) return null;
    if (isExpired(record, now)) { accessStore.delete(digest); return null; }
    if (record.revoked) return null;
    // Deleted/deactivated accounts lose API access immediately, even if a
    // token row somehow survived the deletion purge.
    if (isAccountActive && !isAccountActive(record.userId)) return null;
    return Object.freeze({
      userId: record.userId,
      clientId: record.clientId,
      scopes: Object.freeze([...record.scopes]),
      // Stage 2 principal stamp: "agent" + agentIdentityId for connector
      // grants, "account" for first-party account sign-in clients, null
      // for legacy/unbound grants (doors fail those closed).
      agentIdentityId: record.agentIdentityId ?? null,
      principal: record.principal ?? null,
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
          scopes: [], ip: null, userAgent: null, newestAt: -1, accessTokens: 0, refreshTokens: 0,
          agentIdentityId: null, principal: null };
        families.set(record.familyId, agg);
      }
      if (record.createdAt < agg.issuedAt) agg.issuedAt = record.createdAt;
      if (record.createdAt >= agg.newestAt) {
        agg.newestAt = record.createdAt;
        agg.ip = record.ip ?? null;
        agg.userAgent = record.userAgent ?? null;
        agg.agentIdentityId = record.agentIdentityId ?? null;
        agg.principal = record.principal ?? null;
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
    registerDynamicClient,
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

# OAuth (wave1000 guild-13, 2026-10-08)

Modules: `server/oauth-provider.mjs` (provider side), `server/oauth-provider-store.mjs`
(SQLite), `server/github-oauth.mjs`, `server/google-oauth.mjs` (client side for sign-in).

## 1. OAuth2 authorization server (`oauth-provider.mjs`)

Pure module (no network I/O); state in caller-owned Maps or SQLite.
Implements RFC 6749 code flow + PKCE (S256 **required**), RFC 7009
revocation, RFC 8414 metadata (served by http.mjs).

- **Token formats**: `oac_` auth codes (10 min, single use), `oat_` access
  (1 h), `oar_` refresh (30 d). Secrets are never stored — only SHA-256 hashes.
- **Client registration**: `client_id` `[A-Za-z0-9_-]{1,64}`; redirect URIs
  must be exact-match `https:` (`http:` only for localhost); no fragments.
  Re-registering an unexpired client with different name/URIs fails.
- **PKCE**: `code_challenge` must be 43–128 base64url chars; the verifier is
  checked with `timingSafeEqual(sha256(verifier), challenge)` (mutation M9 —
  inverting this was killed by `tests/oauth-provider.test.js`).
- **Code replay (O1 / issue #941)**: the code row records `familyId` at
  exchange. Replaying a used code → `invalid_grant` **and revokes the whole
  token family** (`authorization_code_reuse_detected` security event),
  per RFC 6749 §10.5. Fuzz F7 verified: replay → invalid_grant, the issued
  access token is dead.
- **Refresh rotation**: each refresh revokes the old refresh token
  (single-use) and records `rotatedBy`. Reusing a rotated refresh token →
  `invalid_grant` + whole-family revocation (`refresh_token_reuse_detected`).
  Fuzz F8 verified. Revoking a refresh token kills its family; revoking an
  access token is surgical.
- **Scopes**: `rooms:read chat:read chat:write work:read work:write`.
  `grants(token, scope)` supports `chat:*`-style prefix wildcards. Unknown
  scopes are rejected at the authorization step.
- **Sessions (F-02)**: `listSessions` shows live families with issuance-time
  IP/UA (coerced, never throws); `revokeSession({userId, familyId})` only
  revokes the caller's own families and returns 0 for unknown/foreign ones —
  the HTTP layer answers 404 without distinguishing.
- **`isAccountActive` hook**: deleted/deactivated accounts lose API access
  immediately, even if a token row survived the purge.

## 2. SQLite store (`oauth-provider-store.mjs`)

- Tables created lazily on first use; `family_id` backfilled idempotently
  (`ALTER TABLE … ADD COLUMN` if missing).
- Records are `Proxy`-watched: any property set auto-persists
  (upsert on conflict). `pruneOAuthProvider` deletes expired rows (bounded,
  `LIMIT`), and is a no-op when tables were never created.
- Mutation M8 (prune's `expires_at <= ?` → `>= ?`, deleting live rows) was
  killed by `tests/oauth-provider-durable.test.js`.

## 3. GitHub OAuth client (`github-oauth.mjs`)

- Pure mechanics: state+PKCE binding, code exchange, user/email fetch.
  All network goes through an injected `fetchFn`; tests never touch the
  network. Errors never carry tokens.
- **Pending states**: single-use, stored under `sha256(state)`, compared
  with `timingSafeEqual`; TTL 10 min; bounded at 1000 (oldest evicted —
  flood can't grow memory). `consume` deletes on read, so any state replay
  fails. Mutation M11 (inverting the expiry check) killed by
  `tests/github-oauth.test.js`.
- **Email trust**: only an email the provider marks `primary === true` AND
  `verified === true` is trusted for linking; otherwise null and the account
  is keyed on the numeric subject. `/user/emails` paginates (30/page) —
  follows `Link: rel="next"` up to 10 pages, **only on the GitHub API
  origin** (never follows a provider-supplied URL off-origin).
- `fetchJson`: 64 KiB cap, `redirect: "error"`, 15 s timeout, no redirects.

## 4. Google OAuth client (`google-oauth.mjs`)

- `GoogleSignIn`: `begin()` binds a browser slot token to PKCE verifier +
  state (10 min, in-memory Map with per-slot dedupe, cap 100, or a
  persistent SQLite store in production for Worker isolate survival);
  `complete()` consumes the state (single-use: in-memory marks `used`),
  exchanges the code, checks the `openid` scope, and verifies the ID token.
- **ID-token checks**: 3 JWT parts; `alg === RS256` only; rejects
  `jku`/`jwk`/`crit` header smuggling; key ≥2048-bit RSA from JWKS
  (cached 1 h, max 16 keys); `iss` must be Google; `aud` must include our
  client id; `sub` numeric; `exp`/`iat` sane (`exp > iat`, `exp-iat ≤ 3600`,
  `iat ≤ now < exp`).
- **M-13 confused-deputy fix**: a multi-`aud` token is accepted only when
  `azp === our clientId` — an `aud` that merely *contains* our id does not
  suffice (a token minted for another app listing us would otherwise pass).
- **Email trust** (RC-2026-09-19-075): only `email_verified === true`
  yields an email; otherwise null, account keyed on subject. Mutation M12
  (trusting unverified email) killed by `tests/google-oauth-email.test.js`.
- `googleConfig`: refuses non-https origins except loopback; client id must
  match the Google pattern; both client id AND secret must be present or the
  flow is "not configured" (honest 503, not a broken redirect).

## Gotchas

- The provider side (`oauth-provider.mjs`) and the sign-in clients
  (`github-oauth`/`google-oauth`) are different directions of the same
  protocol — don't confuse them when reviewing.
- `verifyAccessToken` returns null on unknown/expired/revoked — the HTTP
  layer must map null → 401 (it does).
- OAuth attack cases live in `tests/oauth-provider-attack-cases.test.js`
  (confused deputy, redirect smuggling, scope escalation) — read before
  extending.

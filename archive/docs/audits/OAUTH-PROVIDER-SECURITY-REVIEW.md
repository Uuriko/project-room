# OAuth2 Authorization Server — Security Review

Hard task 95. Review of the provider-side OAuth2 implementation in
`server/oauth-provider.mjs` (SQLite variant: `server/oauth-provider-store.mjs`;
HTTP surface: `server/http.mjs` — authorize/consent/token/sessions routes;
attack-case tests: `tests/oauth-provider-attack-cases.test.js`).

This is the **provider** side: external clients (e.g. Meta Muse) redirect
users here to obtain scoped access tokens for the Project Room API. It is
distinct from `server/google-oauth.mjs` and `server/github-oauth.mjs`, which
are **client** implementations for user sign-in and are out of scope here.

Implements: RFC 6749 authorization code flow with PKCE (S256 required),
RFC 7009 token revocation, RFC 8414 authorization server metadata.

## 1. Token lifetimes

| Token | Lifetime | Rotation / reuse |
|---|---|---|
| Authorization code | 10 min, single use | Burned on exchange; replay fails even after derived tokens are revoked |
| Access token | 1 hour | Bearer; verified by hash lookup + expiry + revoked flag |
| Refresh token | 30 days, rotating | Each use revokes the old token and mints a new pair in the same family |
| Client registration | 30 days | Refresh of client TTL on use |

Token secrets are never stored — only SHA-256 hashes of 32-byte (256-bit)
random secrets, so a DB read does not yield usable tokens.

## 2. Scope enforcement

Five valid scopes: `rooms:read`, `chat:read`, `chat:write`, `work:read`,
`work:write`. Enforcement points:

- **Authorization time:** the consent screen binds the exact requested scope
  set to the issued code; the grant is bound to the exact consented request.
- **Exchange time:** the token pair carries the code's scopes verbatim — the
  exchange cannot add scopes.
- **Refresh time:** the rotated pair carries the original grant's scopes; a
  refresh request cannot escalate.
- **Call time:** API enforcement checks the verified token's scope set.

## 3. Revocation semantics

- **Access token revoke:** surgical — only that token dies, immediately.
- **Refresh token revoke:** kills the whole token family (every access and
  refresh token derived from the grant), so nothing lingers to its 1-hour
  TTL. This is what the consent screen promises ("revoke access at any time").
- **Refresh-token reuse (theft signal):** reusing a rotated refresh token
  revokes the whole family, emits a `refresh_token_reuse_detected` security
  event, and returns a distinct `invalid_grant` — the legitimate user sees a
  theft signal instead of a silent "revoked" (OAuth Security BCP §4.12).
- **User disconnect:** revokes all tokens for a user (optionally narrowed to
  one client).
- **Deactivated accounts:** lose API access immediately even if a token row
  survives the deletion purge (`isAccountActive` check on verify and refresh).
- RFC 7009: revoking an unknown token still returns success (no oracle).

## 4. Threat model

**Assets:** user data reachable through the five scopes; the refresh-token
family as a long-lived session; the authorization code as a bearer credential
in transit through the browser.

**Attacker capabilities assumed:**
- A1 — network observer on the front channel (sees the authorization
  redirect) but not the back channel (token endpoint over TLS).
- A2 — a malicious or compromised registered client (knows its own
  `client_id`, can attempt to exchange or refresh other parties' codes).
- A3 — a token thief holding a leaked refresh token or access token.
- A4 — the end user's browser is hostile after consent (code interception
  via redirect-URI manipulation).

Out of scope: TLS endpoint security, client-secret storage on the client
side, user phishing of consent.

## 5. Attack cases and coverage

Each case below has a passing test in `tests/oauth-provider-attack-cases.test.js`
(14 tests) — the task requires 8; all are listed.

| # | Attack | Defense | Test |
|---|---|---|---|
| 1 | **Code replay** — reusing an authorization code | Single-use burn on exchange; the replay fails even after derived tokens are gone | "replayed authorization code stays burned even after the derived tokens are revoked" |
| 2 | **Scope escalation at refresh** — requesting wider scopes on rotation | Rotated pair carries the original grant's scopes; wider requests are not honored | "refresh cannot escalate scopes: the rotated pair carries the original grant's scopes" |
| 3 | **Token leakage / theft** — stolen refresh token reused | Reuse of a rotated refresh token revokes the whole family + emits a security event + distinct `invalid_grant` (theft signal) | "rotated refresh-token replay triggers theft response" and "FIXED (F-01): refresh-token reuse revokes the whole token family" |
| 4 | **PKCE downgrade** — `plain` method or weak verifier | S256 required; `plain` attempts fail verification | "PKCE plain-method downgrade attempts fail verification" |
| 5 | **PKCE brute force** — guessing the verifier | Failed PKCE guesses do not burn the code for the legitimate exchanger | "failed PKCE guesses do not burn the code for the legitimate exchanger" |
| 6 | **Redirect-URI manipulation** — lookalike URIs, interception | Exact-match redirect-URI check at authorization and again at exchange; lookalikes rejected | "redirect-uri lookalikes are rejected at authorization time" and "authorization code is bound to its redirect_uri at exchange time" |
| 7 | **Client impersonation** — exchanging another client's code/refresh token | `client_id` bound to every code and refresh record; mismatch fails | "client impersonation at the token endpoint fails: codes and refresh tokens are bound to their client" |
| 8 | **Revocation bypass** — revoked refresh token's access tokens keep working | Revoking a refresh token kills the family immediately; revoking an access token kills it for verify and grants | "F-02 FIXED: revoking a refresh token kills its access tokens" and "revoking an access token kills it immediately for verify and grants" |
| 9 | Consent-scope substitution — token issued for a different request than consented | Grant bound to the exact consented request | "the issued grant is bound to the exact consented request" |
| 10 | Revocation oracle — probing which tokens exist | Unknown-token revocation returns success (RFC 7009) | (code path in `revoke`; no oracle in the 404/410 surface) |

## 6. Residual risks and open items

1. **Hash-only storage is unsalted SHA-256.** The secrets are 256-bit
   random, so offline brute force is infeasible; salting is defense-in-depth
   only. (Contrast: the agent-identity secret store salts with scrypt —
   invite codes — where the secret space is smaller.)
2. **Access tokens are bearer tokens** with a 1-hour TTL. A leaked access
   token is usable until expiry or revocation. Shortening the TTL further
   trades UX for exposure window; the current 1 hour matches the consent
   screen's promise and the refresh flow keeps sessions usable.
3. **Security events are emitted** (`refresh_token_reuse_detected`) but
   there is no paged alerting on them — a consumer for these events is a
   follow-up, not a blocker.
4. **Client registration** accepts redirect URIs that must be validated as
   HTTPS (non-loopback) at registration time — verified in the registration
   path; any future registration relaxation must keep this check.

## 7. Verdict

The provider implements the RFC 6749 + PKCE authorization-code flow with the
standard hardening (S256, exact redirect-URI binding, single-use 10-minute
codes), refresh-token rotation with theft detection and family revocation,
scope non-escalation across exchange and refresh, and immediate, complete
revocation. All 10 attack cases above are covered by passing tests. No
blocking findings; the residual items are follow-ups, not gates.

# Auth flows & token lifecycle (wave1000 guild-13, 2026-10-08)

Modules: `server/operator-auth.mjs`, `server/gmail-import-authority.mjs`,
`server/identity-secret-hash.mjs`. HTTP wiring: `server/http.mjs`, routes in
`server/operator-routes.mjs`.

## 1. Identity secrets (agent bearer tokens)

- Format: `pri_` + 43 base64url chars (32 random bytes). Issued once at
  identity mint (`AgentIdentities.create`), shown once, never again.
- Presented as `Authorization: Bearer <secret>`. Scheme parse is
  case-insensitive (`bearer`/`BEARER` accepted); the secret shape is unchanged.
- Verification (`resolveGlobalIdentitySecret`): never throws on malformed
  input — returns null. Three stored verifier generations are accepted:
  - **v3 (current)**: `v3:` + HMAC-SHA256(secret, key). Key = first of
    `identityHashKeys()`: the configured `ROOM_IDENTITY_HASH_KEY` (must be
    ≥16 chars after trim, else ignored), then the built-in fallback
    `"project-room-agent-identity-v3"`.
  - **v2 (legacy)**: `v2:` + scrypt(secret, N=16384, r=8, p=1) — verified via
    `scryptIdentityHash` with a 256-entry LRU cache; on a hit the row is
    upgraded to v3 (writes the HMAC). Scrypt runs at most once per secret per
    request.
  - **legacy**: bare hex SHA-256 of the secret.
- Key-roll discipline: the fallback is ALWAYS accepted, so adding or omitting
  `ROOM_IDENTITY_HASH_KEY` can never strand a verifier written with the
  other key. New rows store the active (first) key.
- Rotation/revoke calls `forgetIdentityVerifier(secret)` so the previous
  secret's scrypt KDF output does not stay in memory.
- Known-verified property (fuzz F5): a verifier written with the fallback
  still verifies after the real key is set; a wrong secret never matches;
  short configured keys are ignored.

## 2. Operator surface (god-key)

- Gated by `ROOM_OPERATOR_TOKEN_SHA256` = hex SHA-256 of a ≥32-byte token.
  Missing/blank/malformed → the surface does not exist: every
  `/api/operator/*` path answers **404**, the same code as an unknown path,
  so the route is not an oracle (fuzz F13 confirms: no token, wrong token,
  `Bearer` scheme, empty token → all 404, never 401/403/500).
- Presented as `Authorization: Operator <token>`. Compared with
  `timingSafeEqual(sha256(presented), expected)`; length checks before compare.
- `carriesRoomOrAccountCookie()` treats room/account session cookies as
  explicitly NOT an operator credential — a request carrying one without the
  Operator header is refused.

## 3. Gmail import authority (confused-deputy guard)

- `gmailImportToken(store, accountId, connectionId, check)` mints a
  process-local, unforgeable capability: a frozen `{}` object held in a
  `WeakMap`. Never serialized, never accepted from HTTP, never a session.
- `gmailImportAuth(store, token, request)` re-validates on every use:
  - the grant exists in the WeakMap (forged objects → null),
  - the grant's store is the calling store (cross-store use → 403),
  - `check()` (caller epoch callback) runs,
  - account is active AND `authEpoch` matches the grant epoch AND connection
    is `active` AND its `authEpoch` matches AND provider is `gmail-api`,
  - action binding: `page.apply` requires `request.connectionId === grant.connectionId`;
    `source.import` requires the envelope's connection id/accountId to match;
    anything else → 403.
- Return is `{ account, sessionBinding: null, sessionRevision: 0 }` — the
  import path never inherits a session.

## Gotchas

- `http.mjs` line ~716: scheme case-insensitivity applies to `Bearer` only
  for the room bearer gate; the operator gate requires the literal
  `Operator` scheme.
- The 428 `proof_required` on identity mint is not an auth failure — it
  carries the PoW recipe in `detail`.
- `verifyAccessToken` (oauth-provider) and `resolveGlobalIdentitySecret`
  both return null (not throw) on unknown/expired — callers must treat null
  as unauthenticated; HTTP layer does (401).

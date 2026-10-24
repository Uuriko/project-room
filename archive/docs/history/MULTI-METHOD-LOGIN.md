# Multi-method login (program, slices 1–7)

One account, many login credentials. Each method links to an account and can
be listed, disabled, or removed independently; the account keeps working as
long as at least one active method remains. Agent identities
(`server/agent-identities.mjs`), invite links, and share links are untouched
by this program.

## Method model (slice 1 — this slice)

`server/account-login-methods.mjs` owns four additive tables
(`account_login_methods`, `account_passkey_credentials`,
`account_magic_codes`, `account_recovery_codes`), installed idempotently in
`RoomStore` and listed in `unfencedAdditiveTables` (same pattern as
`access_requests`): older writers have no code path to them.

| Type | Verifier at rest | Notes |
|---|---|---|
| `password` | scrypt hash (slice 2) | one active per account |
| `magic` | — (codes ephemeral) | verified email address; codes are sha256-hashed, 15-min TTL, single-use, 5-attempt burn |
| `oauth` | provider subject | `github` / `google`; keyed on subject, never email |
| `passkey` | public COSE key + JWK | one method row per credential; private key never leaves the authenticator |
| `recovery-code-set` | sha256(salt ‖ code) | one active set per account; burn-on-use; plaintext shown exactly once |

## Linking rules

- OAuth and magic-link sign-ins **link on the provider-attested subject or
  the verified email's existing owner**: if `findAccountByVerifiedEmail` /
  `findAccountByOAuth` finds an account, the method attaches to it instead
  of provisioning a new one. Email alone never claims an account without a
  verified code or provider assertion.
- The settings UI lists methods through `listMethods`, which never returns
  verifiers, code hashes, or secrets.
- Disabling/removing the last active method is refused (`409
  last_login_method`).

## Security conventions

- No secret values in logs or API responses (follows `docs/SECRETS-ROTATION.md`).
- Constant-time comparison for code digests (`constantTimeDigestEqual`);
  scrypt verification is in `src/password-auth.mjs` (slice 2).
- Rate limits: per-IP/per-email token buckets via
  `server/identity-ratelimit.mjs`, wired at the HTTP layer like
  `server/access-requests.mjs`.
- Slot upgrade (`loginAccountSession*`) stays the single commit that turns
  a verified method into an F017-style account session.

## Slices

1. Credential-type model (this doc) — `server/account-login-methods.mjs`.
2. Email+password signup/login — `src/password-auth.mjs` (scrypt), HTTP routes, tests.
3. Magic-link codes — mail-sender seam with an honest unconfigured state, HTTP routes, tests.
4. GitHub OAuth (Google already exists) — state+PKCE, method linking, tests.
5. Passkey registration+authentication — `src/passkey-login.mjs` wired to the server credential store, tests.
6. Recovery codes — generate/consume/burn, HTTP routes, tests.
7. Account settings UI — linked methods list with add/remove, honest empty states when a provider is unconfigured; browser coverage for password + magic-link happy paths.

# Secrets Rotation Runbook (F005)

Operational maturity for the project's credential story: a single, repeatable
procedure for rotating every secret type the room uses. There is no
`src/totp-2fa.mjs` and the server does not enroll TOTP. Passkeys are
implemented: `server/account-passkeys.mjs` wires the WebAuthn ceremonies in
`src/passkey-login.mjs`. Audit-receipt signing is F020
(`src/audit-receipts.mjs`). Local account access keys are described in
`docs/SERVICE.md`. Recovery codes live in `server/account-login-methods.mjs`.

**No real secrets appear in this document.** Every value shown is a placeholder.
Generate a secret once, store it server-side, never log it, and never persist
a provisioning URI beyond the enrollment screen.

Every rotation below follows the same five-phase pattern:

1. **Generate** — new secret from a CSPRNG, server-side, before anything else.
2. **Distribute** — place the new secret only where it is needed, over an
   authenticated channel.
3. **Dual-run / overlap window** — both old and new secrets are accepted. This
   is the window where mistakes are recoverable.
4. **Cutover** — the new secret becomes the only accepted one; confirm with a
   verification step that requires the new secret to work.
5. **Revoke old** — destroy the old secret everywhere it was stored. The
   rotation is not done until the old value is unrecoverable.

## 1. Secret inventory

| Secret type | Where it lives | Owner module | Storage rule |
|---|---|---|---|
| TOTP enrollment seeds | Not stored. `src/totp-2fa.mjs` is not in the tree | None | There is no TOTP seed to rotate |
| Passkey credentials (public keys + credential IDs) | Server-side credential store | `server/account-passkeys.mjs` (`src/passkey-login.mjs`) | Private key material never leaves the authenticator; store public key + credential ID per account |
| Local account access keys | Server-side account store; printed once to the operator | Service layer (`docs/SERVICE.md` `--account-key`); 7-day keys | One active key per account; revoked copies unusable |
| Audit-receipt signing key | Supplied by the caller of `src/audit-receipts.mjs` (`issueReceipt` / `verifyChain`) — never hardcoded, never read from env inside the module | F020 `src/audit-receipts.mjs` (HMAC-SHA256) | Operator-held; keep outside the receipt chain itself |
| Recovery codes | Salted hashes, server-side, per account | `server/account-login-methods.mjs` (`generateRecoveryCodes`) | Single-use; shown once at generation; burn on use |
| Operator/API tokens | Room host config / deployment environment | Deployment (outside the tree) | Shortest TTL the deployment supports |

## 2. Rotation cadences

Cadence is policy, not code. These are the defaults; tighten them for
high-risk accounts, loosen none without writing down why.

| Secret type | Scheduled rotation | Event-driven rotation |
|---|---|---|
| TOTP seeds | None. The server does not enroll TOTP, so there is no seed to rotate. | Not applicable |
| Passkey credentials | **On demand only.** Rotate by registering a replacement credential and deleting the old registration. | Authenticator lost/sold/reset, account compromise |
| Local account access keys | Every 7 days (the issued TTL), or immediately via `--account-key` rotation | Suspected compromise; account suspension/re-activation cycle (`docs/SERVICE.md`: suspension increments the authorization epoch and revokes both account and Room credentials) |
| Audit-receipt signing key | **Annually**, or whenever the operator roster changes | Suspected key exposure |
| Recovery codes | Re-issued by generating a new set, which replaces the previous hashes | Code set partially used, or suspected exposure of a shown code |
| Operator/API tokens | Per the deployment's TTL; re-issue on any operator change | Operator departure, suspected leak |

## 3. Rotation procedures

### 3.1 TOTP seed rotation

`src/totp-2fa.mjs` is not in the tree. The server has no TOTP enrollment and
stores no TOTP seed, so this runbook has no TOTP generate, confirm, or
cutover step. `docs/history/TOTP-2FA.md` describes a module that was not
shipped.

### 3.2 Passkey credential rotation

Passkey registration and sign-in are live. `server/account-passkeys.mjs`
issues the WebAuthn challenge and stores the public key and credential id.
The private key stays on the authenticator.

1. **Generate.** With a signed-in account session, `POST /api/auth/passkey/register/options`,
   then `POST /api/auth/passkey/register/finish` with the authenticator's
   response. The server creates the registration challenge; the private key
   never crosses the wire.
2. **Distribute / register.** `finishRegistration` verifies the attestation
   and stores the credential public key and credential id against the account.
3. **Overlap window.** Keep the old credential while the owner confirms the
   new one with `POST /api/auth/passkey/authenticate/options` and
   `POST /api/auth/passkey/authenticate/finish`.
4. **Cutover.** After that confirming sign-in, the new credential is active.
5. **Revoke old.** `POST /api/auth/methods/remove` deletes the replaced
   passkey method. Other authenticators on the account stay. The last active
   sign-in method cannot be removed.

Rollback: until step 5, the old credential still signs in. Discard an
unfinished registration by letting its challenge expire (five minutes) and
start again. "Revoke old" means that one credential, not every passkey on
the account.

### 3.3 Local account access key rotation

Per `docs/SERVICE.md`, `--account-key --account ID` creates the local account
if absent, or **rotates its account key if present**, then prints the new
seven-day key once. It grants no Room membership.

1. **Generate.** The service mints the new key; the operator receives it on
   the one-time print.
2. **Dual-run.** Existing authenticated account-session slots remain valid
   until the operator confirms the new key works (e.g. one successful
   account-session login with the new key).
3. **Cutover.** Rotation revokes earlier account keys and clears
   authenticated account-session slots.
4. **Revoke old.** Earlier keys are already revoked by the rotation itself;
   confirm no session authenticated with the old key survives (re-check
   session slots).

Rollback: if the new key print is lost before confirmation, rotate again —
the service's rotation primitive is idempotent and each rotation revokes the
previous key, so a lost print is recoverable by re-running it, not by
resurrecting the old key.

### 3.4 Audit-receipt signing key rotation (F020)

The signing key is supplied by the caller — it is never hardcoded and never
read from the environment inside `src/audit-receipts.mjs`. That makes rotation
an operator procedure, not a code change.

1. **Generate.** Mint a fresh key from a CSPRNG (at least 256 bits),
   operator-held, stored outside the receipt chain.
2. **Overlap.** Start issuing new receipts with the new key. Keep the old key
   available to `verifyChain` for historical receipts — the chain's
   tamper-evidence depends on being able to re-verify old signatures.
3. **Checkpoint.** Pick a cutover receipt (the first one signed with the new
   key) and record its `seq` in the operator log. Receipts with `seq` below
   the checkpoint verify with the old key; at or above, with the new key.
4. **Cutover.** After the checkpoint is recorded, the old key is
   verification-only: it must never sign a new receipt again.
5. **Revoke old (delayed).** Retire the old key only after the retention
   window for its receipts expires or the chain segment is re-anchored under
   the new key — whichever the operator policy says. Deleting it early breaks
   historical verification.

Rollback: if the new key is lost before any receipt is signed with it, delete
it and keep using the old key — nothing changed. If receipts were already
signed with the new key and the new key is lost, you cannot roll back: the
chain continues, but new receipts must be signed with a *third* key and the
checkpoint log must record two cutovers. Never re-sign old receipts.

### 3.5 Operator/API token rotation

1. **Generate** the replacement token in the deployment's secret store.
2. **Overlap** — run the service with both tokens accepted (or deploy the new
   token to a canary host first) for one full operational cycle.
3. **Cutover** — point all callers at the new token; confirm with a
   token-authenticated health check.
4. **Revoke old** — disable the old token in the provider/store, then confirm
   one authenticated call with the old token fails.

## 4. Rollback rules (apply to every type)

- **A rotation is not a cutover until the verification step passes.**
  Verification always means *exercising the new secret* (a real code, a real
  sign-in, a real signed receipt), never just confirming it was stored.
- **Keep the old secret recoverable during the overlap window, and only
  during it.** "Recoverable" means retrievable by the operator — not
  co-active with the new secret where the module forbids it.
- **Revocation is the last step, not the first.** A rotation that starts with
  revocation is a lockout, not a rotation.
- **Log every rotation** as an audit event: what type, which account, when,
  scheduled vs emergency — never the secret values.
- **If cutover fails, the system must be in the pre-rotation state.** If it
  is not (partial writes), treat it as a suspected-compromise event (section
  5) and rotate again from a clean state.

## 5. Suspected compromise — emergency rotation

Assume the secret is already in hostile hands; speed beats elegance.

1. **Contain first.** For an account: suspend the account (`docs/SERVICE.md` —
   revision-check the account state, increment its authorization epoch,
   revoke both account and Room credentials across Rooms, require fresh
   credentials after reactivation). For a signing key or operator token:
   revoke/disable it *now*, before generating the replacement — emergency
   rotation is the one case where revocation leads.
2. **Rotate from a clean state.** Run the standard procedure for the secret
   type (section 3), but skip the overlap window: old secret dead, new
   secret live, no dual-accept.
3. **Re-issue dependents.** A suspected account compromise means a new
   recovery-code set: `generateRecoveryCodes` replaces the previous hashes.
   A compromised signing key means a new checkpoint per 3.4 and a review of
   receipts signed during the exposure window.
4. **Verify and audit.** Run the full verification checklist (section 6) and
   log the incident as an audit event: suspected-compromise flag, scope of
   what was rotated, exposure window estimate.
5. **Tell the owner.** If an owner's credentials were rotated for them,
   notify them through a channel independent of the compromised one.

## 6. Verification checklists

Run these after every rotation; every item must pass before the rotation is
closed.

### All types
- [ ] New secret was exercised successfully (code verified, sign-in
      completed, receipt signed and verified, token-authenticated call made)
- [ ] Old secret no longer works (login attempt fails, old signature
      rejected for new receipts, old token call fails)
- [ ] Rotation logged as an audit event with type, account, timestamp, and
      scheduled/emergency flag — no secret values in the log
- [ ] No copy of the old secret remains in operator notes, chat history,
      screenshots, or provisioning URIs

### TOTP
- [ ] No step. The server does not enroll TOTP.

### Passkey
- [ ] New credential completed a real sign-in ceremony
      (`/api/auth/passkey/authenticate/finish`)
- [ ] Only the intended credential registration was revoked (other
      authenticators on the account untouched)

### Local account keys
- [ ] No authenticated session survives from the old key (session slots
      re-checked after rotation)

### Audit-receipt signing key (F020)
- [ ] `verifyChain` passes across the checkpoint with the correct key per
      segment (old key for `seq` < checkpoint, new key at/above)
- [ ] Old key can no longer sign (caller-side enforcement confirmed)

## 7. Not covered / out of scope

This runbook does not cover:

- **TOTP enrollment.** `src/totp-2fa.mjs` is not in the tree, so there is
  no enrollment flow to rotate.
- **First-ever passkey registration** is the same ceremony as section 3.2;
  this runbook covers replacing a credential that already exists.
- **Recovery-code storage** is `account_recovery_codes` in
  `server/account-login-methods.mjs`. Generating a set replaces the previous
  hashes and returns the plaintext codes once.
- **Room-scoped keys and legacy Room credentials** — `docs/SERVICE.md` notes
  account-key rotation does not revoke legacy Room-scoped keys; rotating
  those is a separate procedure this runbook does not define.
- **Key escrow, HSMs, or secret-management vendors** — where the
  operator-held keys (audit signing key, operator tokens) are physically
  stored is a deployment decision outside this document.
- **Legal/compliance retention** for audit receipts — the delayed-revocation
  rule in 3.4 assumes a retention policy exists; this runbook does not set
  it.
- **Incident forensics** — this runbook covers secret replacement after a
  suspected compromise, not root-cause analysis of how the compromise
  happened.

# Secrets Rotation Runbook (F005)

Operational maturity for the project's credential story: a single, repeatable
procedure for rotating every secret type the room uses. TOTP enrollment and
verification live in the **F018 TOTP module** (`src/totp-2fa.mjs`, see
`docs/TOTP-2FA.md`); passkey support is the **F019 passkey module** (planned
slice, not yet in the tree). Audit-receipt signing is F020
(`src/audit-receipts.mjs`). Local account access keys are described in
`docs/SERVICE.md`.

**No real secrets appear in this document.** Every value shown is a placeholder.
Treat a real secret the way `docs/TOTP-2FA.md` does: generate once, store
server-side, never log it, never persist a provisioning URI beyond the
enrollment screen.

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
| TOTP enrollment seeds | Server-side, one per owner account | F018 `src/totp-2fa.mjs` (`generateSecret()`) | Stored once against the account; never in logs, QR URIs not cached |
| Passkey credentials (public keys + credential IDs) | Server-side credential store | F019 passkey module (planned slice) | Private key material never leaves the authenticator; store public key + credential ID per account |
| Local account access keys | Server-side account store; printed once to the operator | Service layer (`docs/SERVICE.md` `--account-key`); 7-day keys | One active key per account; revoked copies unusable |
| Audit-receipt signing key | Supplied by the caller of `src/audit-receipts.mjs` (`issueReceipt` / `verifyChain`) — never hardcoded, never read from env inside the module | F020 `src/audit-receipts.mjs` (HMAC-SHA256) | Operator-held; keep outside the receipt chain itself |
| Recovery codes | Salted hashes, server-side, per account | TOTP recovery slice (follow-up to F018) | Single-use; shown once at enrollment; burn on use; audit-logged |
| Operator/API tokens | Room host config / deployment environment | Deployment (outside the tree) | Shortest TTL the deployment supports |

## 2. Rotation cadences

Cadence is policy, not code. These are the defaults; tighten them for
high-risk accounts, loosen none without writing down why.

| Secret type | Scheduled rotation | Event-driven rotation |
|---|---|---|
| TOTP seeds | **On demand only.** TOTP seeds do not expire on a schedule; rotating a working seed adds risk, not security. Rotate when the device is lost, replaced, or the recovery-code path was used. | Device loss, authenticator app reset, suspected seed exposure, break-glass recovery-code use |
| Passkey credentials | **On demand only.** Rotate by registering a replacement credential and deleting the old registration. | Authenticator lost/sold/reset, account compromise |
| Local account access keys | Every 7 days (the issued TTL), or immediately via `--account-key` rotation | Suspected compromise; account suspension/re-activation cycle (`docs/SERVICE.md`: suspension increments the authorization epoch and revokes both account and Room credentials) |
| Audit-receipt signing key | **Annually**, or whenever the operator roster changes | Suspected key exposure |
| Recovery codes | Re-issued whenever a TOTP re-enrollment happens; burned individually on use | Code set partially used → top up only after re-confirming the TOTP device |
| Operator/API tokens | Per the deployment's TTL; re-issue on any operator change | Operator departure, suspected leak |

## 3. Rotation procedures

### 3.1 TOTP seed rotation (F018)

The account's TOTP seed is the one secret in this table that only the owner
can complete — the new seed must be provisioned into the owner's authenticator
app, so the owner has to be reachable.

1. **Generate.** Server-side, call `generateSecret()` from `src/totp-2fa.mjs`.
   Hold it as *pending*; do not overwrite the current seed yet.
2. **Distribute.** Build the provisioning URI with `provisioningUri({ issuer,
   account, secret })` and render the QR on an authenticated owner-only
   screen. Same rule as enrollment: do not log, cache, or persist the URI
   beyond the screen.
3. **Confirm (the overlap).** Require the owner to type the current code from
   their app and verify with `verifyCode(code, newSecret)`. This is the
   overlap window: the *old* seed still gates logins until this step succeeds.
4. **Cutover.** Only after a successful confirmation: store the new seed
   against the account and flip the account to the new seed.
5. **Revoke old.** Delete the old seed from the account record. There is no
   dual-accept window for TOTP (two live seeds would double the code-guessing
   surface), which is exactly why step 3 must succeed first.
6. **Re-issue recovery codes.** A TOTP re-enrollment always burns the old
   recovery-code set and issues a fresh set of 8–10 single-use codes (store
   salted hashes; show once; require the owner to acknowledge saving them).

Rollback: if step 3 fails (mis-scanned QR), nothing changed — the old seed is
still the only active one. Discard the pending seed and restart at step 1.
Never cut over to an unconfirmed seed.

### 3.2 Passkey credential rotation (F019)

F019 is the passkey module slice; these are the procedure requirements that
slice must satisfy, stated here so the runbook stays accurate when it lands.

1. **Generate.** The new credential is generated on the owner's authenticator
   via the standard WebAuthn registration ceremony. The server creates the
   registration challenge; the private key never crosses the wire.
2. **Distribute / register.** The server verifies the attestation and stores
   the credential public key + credential ID against the account as *pending*.
3. **Overlap window.** Keep the old credential registration active while the
   owner confirms the new one with a real sign-in using the new passkey.
4. **Cutover.** After the confirming sign-in, mark the new registration
   active and the old one revoked.
5. **Revoke old.** Delete the old credential ID and public key from the
   account record.

Rollback: until step 4, the old credential is untouched — discard the pending
registration and restart. Passkey rotation must support multiple active
credentials per account (owners legitimately have two authenticators), so
"revoke old" here means revoking the *specific replaced* credential, not
wiping the account's whole credential set.

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
  co-active with the new secret where the module forbids it (TOTP allows no
  dual-accept; see 3.1).
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
3. **Re-issue dependents.** A compromised TOTP seed means fresh recovery
   codes too. A compromised signing key means a new checkpoint per 3.4 and a
   review of receipts signed during the exposure window.
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

### TOTP (F018)
- [ ] `verifyCode` succeeds with the new seed and the ±1-step window policy
      from `docs/TOTP-2FA.md`
- [ ] Fresh recovery-code set issued, old set burned, owner acknowledged
      saving the new set

### Passkey (F019)
- [ ] New credential completed a real sign-in ceremony
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

- **Initial enrollment** of TOTP (F018 enrollment flow is in
  `docs/TOTP-2FA.md`) or the first-ever passkey registration (F019 slice).
- **Recovery codes as a product surface** — generation rules are referenced
  from F018's recovery-code guidance; the dedicated recovery slice owns the
  storage schema and break-glass UX.
- **The F019 passkey module itself** — this runbook states the rotation
  procedure it must satisfy, but the module (registration ceremony,
  attestation verification, credential store schema) is a separate slice and
  not yet in the tree.
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

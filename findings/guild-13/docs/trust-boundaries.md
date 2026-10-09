# Trust boundaries & gotchas (wave1000 guild-13, 2026-10-08)

## Trust boundaries in the auth-identity slice

```
 ┌─ public/anonymous ─────────────────────────────────────────────┐
 │ POST /api/agent-identities      room_identity_mint (MCP)        │
 │ POST /api/guest-invites/request  (signed card = credential)     │
 │ POST /api/agent-invites/redeem   (the code IS the credential)    │
 │ POST /api/referral-invites/redeem (Ed25519-signed token)        │
 │ POST /api/guest-invites/preview  (metadata only, 410 on miss)   │
 └────────────────────────────────────────────────────────────────┘
 ┌─ bearer (pri_ secret) ─────────────────────────────────────────┐
 │ member actions, invite mint, referral mint, OAuth consent       │
 │ guest ga1. credential → guest:* scopes only, per-request gate   │
 └────────────────────────────────────────────────────────────────┘
 ┌─ account session (cookie) ─────────────────────────────────────┐
 │ account-scoped routes; NEVER an operator credential (explicit)  │
 └────────────────────────────────────────────────────────────────┘
 ┌─ operator (Authorization: Operator <token>) ─────────────────────┐
 │ /api/operator/* — 404 when the surface is off (not an oracle)   │
 └────────────────────────────────────────────────────────────────┘
 ┌─ process-local only (never serialized, never HTTP) ──────────────┐
 │ gmailImportToken capability (WeakMap)                            │
 └────────────────────────────────────────────────────────────────┘
```

## Boundary rules (each verified by fuzz F1–F20)

1. **An identity grants nothing.** Mint → link → join are separate steps;
   the link step is where the verification gate and permission grants live.
2. **Invite codes are hashes at rest.** Plaintext exists only in the mint
   response (agent/guest) or the signed token (referral). The DB never
   holds a usable code.
3. **Burns are compare-and-swap inside the admission transaction.**
   Exactly one redemption wins; replays are 409/404, never a second
   membership. Self-serve replays are idempotent and tokenless.
4. **The inviter's authority is re-checked at redemption** (agent invites,
   referral ledger). A demoted issuer's outstanding codes die.
5. **Permissions never widen client-side.** Profiles map server-side;
   `neverGrant` = manage_members/decide/invite_member; non-owners can only
   grant bits they hold; junk fields in redeem bodies are ignored.
6. **Token families die together.** Code replay or refresh-token reuse
   revokes the whole family and emits a security event — a theft signal,
   not a silent rejection.
7. **Errors are fail-closed and non-oracular.** Unknown vs malformed vs
   expired collapse into small status sets (F4: garbage/unknown/identityId
   Bearer → identical 401s; F11: 120 forged GX probes → only 404/410;
   F13: operator probes → all 404). 500s never escape to the caller on
   these paths.
8. **Email is never trusted from an unverified claim.** GitHub: needs
   primary+verified; Google: needs `email_verified === true`; else null
   and the account keys on the provider subject.
9. **Multi-audience tokens need `azp`.** A Google ID token whose `aud`
   merely contains our client id is rejected unless `azp` pins it (M-13).
10. **The Gmail import capability is a process-local object**, re-validated
    on every use (store identity, epochs, connection state, action
    binding). Cross-store or cross-connection use → 403.

## Gotchas (from reading the code)

- `checkOrigin(req, !carriesBearer(req))` — Bearer calls skip the Origin
  check (they're not ambient); cookie calls enforce it. Don't "simplify"
  this into a single check.
- The journal's checksums detect inconsistency; they don't authenticate a
  DBA. `assertInvitationMembershipEvidence` compares against the *era's*
  event shape (pre-W4 events lack `displayNamePolicyVersion`) — don't
  "fix" old events to the new shape.
- OAuth `revoke(unknownToken)` returns success per RFC 7009 — that's not a
  bug, it's the spec.
- `verifyAccessToken` and `resolveGlobalIdentitySecret` return null rather
  than throwing — callers that forget the null check fail OPEN. Grep for
  new callers.
- Identity-mint PoW (12-bit) is a speed bump; the address/network/daily
  caps are the real budget. Don't raise `proofFreePerAddress` casually.
- The operator surface's 404-on-unset is load-bearing: changing it to
  401/403 would turn every probe into an oracle.

## Dead-code audit (reachability evidence, 2026-10-08)

Method: `grep -rl <export> server/ src/` excluding the defining module.

| Export | External users | Verdict |
|---|---|---|
| `operatorEnv` (operator-auth) | 0 — used 4× inside its own module (default params) | live, internal |
| `oauthProviderTablesPresent` (oauth-provider-store) | 0 — used by `pruneOAuthProvider` in-module | live, internal |
| `identityMintMcpDefinitions` (mcp-identity-mint) | 0 direct — aliased by `anonymousIdentityMintMcpTools` (1 user); drift-checked at load | live |
| all other slice exports | ≥1 | live |

**No dead code found in the slice.** Everything exported is reachable from
runtime code or tests; the three zero-external-user exports are internal
helpers exercised via their modules' own functions.

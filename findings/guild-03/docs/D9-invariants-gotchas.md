# Guild-03 docs — D9: slice invariants + gotchas

Verified against code at origin/main b53c52af (2026-10-09).

## Invariants (hold across the whole routes-mcp slice)

1. **Unknown errors are rethrown, never wrapped.** Every route module maps
   its domain errors (FeedbackError/EscrowError/ClaimError/AgentPluginError/
   typed collab errors) to stable 4xx codes and rethrows anything else to
   the generic 500 path — so no internal detail leaks. (feedback-routes,
   bounty-escrow-routes `runPure`, work-claim-routes `runPure`/`retire`,
   inbox-collab `collabHttpError`, agent-plugin `translateWith`.)
2. **Auth identity is re-checked after body upload.** Bounty escrow,
   inbox-collab POST, and work-claim close/link all `reauthorize()` inside
   the storage transaction; an identity change mid-request → 403
   `access_denied`. (Mutation M10b: this check has no test — test gap.)
3. **Strict body shapes.** `shape()` (bounty, collab) and `exact()`
   (agent-plugin, legal): required keys present, no unknown keys. Malformed
   JSON → 422, never 400, on the room routes.
4. **Method mismatch → 405 with Allow.** Consistent across collab routes,
   MCP transport, legal, operator.
5. **JSON-RPC errors ride HTTP 200** except auth failures (401 +
   WWW-Authenticate). Notifications get 202/empty, never a body.
6. **Request ids**: string ≤128 chars or safe integer, everywhere on the MCP
   surface (mcp-http, identity-mint, public-work, room-profile).
7. **Withheld, never refused** (discovery): capabilities outside an agent's
   grants are absent from tools/list, never present-but-denying. Call-time
   denials mirror the catalog filter exactly (capability-visibility.mjs).
8. **Idempotency keys** (bounty escrow + public work + work claims):
   same key + same payload scope → replay the stored receipt; different
   payload with the same key → 409. Retries never duplicate credit movement
   or publish events twice.
9. **Spend discipline** (chargeSpendBeforeCall): settle on success, void on
   error/throw/unconfirmed, void on idempotent replay. Never charge for an
   unknown outcome. Autonomy denials outrank spend.
10. **Room Guide choke point**: `refuseRoomGuideOffStarter` runs before the
    owner check on work-claim writes — the guide gets `guide_starter_only`,
    not `work_not_owner`.
11. **Every committed board change emits exactly one `work_claim.updated`
    room event in the same transaction** (work-claim `commit()`), plus wakes.
    (Wave300 data-plane-fastpath deliberately breaks this — see reverify-R1.)

## Gotchas

- **`scripts/room` flags are global**: `scripts/room --dry-run sweep` is a
  dry run; `scripts/room sweep --dry-run` runs LIVE. (Pre-existing lesson,
  applies to any enforcer work on this slice.)
- **MCP `fast` is dead on arrival** (wave300/data-plane-fastpath): the
  dispatcher reads `rest.fast` but the tool schemas (additionalProperties:
  false) reject it. Only HTTP `?fast=1` works. (reverify-R1, FINDING R1-1.)
- **`credential` vs `secret`** (agent-plugin): issue/rotate return
  `credential: "rak_"+secret` (presentation-ready) and keep `secret` raw
  for backward compat. Agents must send `credential` as the Bearer token.
- **Empty `Bearer`** on /mcp is treated as no credential → public join
  tools still load (an unset secret variable in a host config doesn't
  hard-fail).
- **HEAD on `/feedback/notifications` never drains** (H-22): only GET
  drains; HEAD reports `drained:false`.
- **`?fast=1` on work-claim reads skips `sweepRoom`/`closeLiveClaims`**:
  readers see stored lease state as-is; expiry is then owned by the reaper
  tick (verify it exists).
- **Sybil resolve is owner-only at TWO layers**: the route pre-check AND
  the in-transaction check in `idem()` (bounty-escrow-routes). Both must
  stay; the pre-check avoids reading the body for non-owners.
- **`isRoomOwner` compares canonical lane forms** — member ids may be
  `id:agent:jill` or `id:agent/jill`; a raw string comparison locks the
  real owner out (the #2043 lockout; route-layer half lives here).
- **Approval verdicts need a HUMAN** (`asHuman()`): an agent caller gets
  403 `human_required` with instructions, enforced both at the route and in
  the queue (`approval_not_human`).
- **Routing `resolvedBy` is refused, not ignored**: the resolver is always
  the authenticated caller (inbox-collab M-7) — attribution nobody can
  vouch for is worse than none.
- **Receipt cursors are opaque base64url** (`{offset}`); offset 0 is valid.
  `q` ≤ 500 chars, `limit` 1..50, tags `[A-Za-z0-9_-]{1,32}`.
- **Public-work `finish` receipts prove bytes only** (`sha256_bytes_only`)
  — not acceptance, not payment.
- **Trust attestation is never self-asserted**: `identity_read_verification`
  reads; attesting is a room-owner seat off the MCP surface (sybil vector
  otherwise).
- **Supervision routes are NOT mounted** (deferred to the integration
  lane) — `handleSupervisionRoutes` is currently unreachable from HTTP.
- **`allowed()` in mcp-room-profile**: unknown arg keys → false (invalid
  arguments), required keys must be own-properties.
- **Dotted MCP aliases** (`bond.list`) resolve via `canonicalMcpToolName`
  and stay hidden unless `aliases=1` — but the anonymous join path never
  suggests hosted tool names (#1528).

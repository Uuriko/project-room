# server/work-claim-events.mjs

Work-claim room events. A claim/renewal/handoff/release used to change only
the `work_claims` table — invisible in the room, the event tail, the digest,
and agents' wake feeds — so agents re-announced every claim in chat. Each
committed claim change now appends one thin `work_claim.updated` room event,
attributed to the member who made it. The `work_claims` table stays the
source of truth; the event carries a pointer plus the state a reader needs
(`claimState`, not `state`: the envelope reserves `data.state` for
`land.updated`).

Same append path as the land queue (`server/land-queue.mjs` #emit): the event
row and the projection update run inside the caller's claim transaction, so a
claim and its event commit or roll back together.

## Public API

| Export | Behavior |
|---|---|
| `WORK_CLAIM_ACTIONS` | Re-export of `WORK_CLAIM_EVENT_ACTIONS` from src/events.js. |
| `workClaimEventData(item, action, opts)` | Shapes the event payload: `workClaim`, `action`, `claimState`, `ownerId`, `leaseExpiresAt`, `title` (falls back to id when blank — the envelope rejects blank strings), `paths`; plus PR outcome, reason, ciState, verdict, attention fields when present. Throws on unknown action or non-list paths. |
| `enqueueClaimWake(store, roomId, memberId, messageId, {reason, actorId})` | Wakes a member through the agent wake queue (`kind: "mention"`, messageId `work-claim:{id}:{reason}:…` so hosts can triage). Skips when paused, t1_readonly tier, or trust-off blocks the wake. A wake failure logs and returns null — it never rolls back the claim. |
| `wakeNamedReviewers(store, roomId, item, {actorId})` | One wake per new head for each named reviewer who hasn't reviewed that head yet (message id carries the head so repeats coalesce). Only for `in_progress` items or items with a linked PR. |
| `claimEventCoalesced(store, roomId, claimId, action, atMs)` | SEC-2/Q3-A event budget: note-only writes (notes, review notes, renewals) coalesce to at most one room event per claim+action per 60s. Transitions, assignments, verdicts, PR facts are never coalesced. Memory-only per store (a restart allows one extra event). |
| `emitWorkClaimEvent(store, roomId, {...})` | Appends the `work_claim.updated` event + projection update in the caller's transaction; skips when the room is archived (the claim write still commits); fans out via `agentPlugin.fanoutRoomEvent`; posts an in-room receipt card for `done` claims. Returns `{sequence, event}` or null. |
| `CLAIM_EVENT_COALESCE_MS` | 60_000. |

## Invariants

- One claim change → at most one room event (coalescing aside), in the same
  transaction as the claim write.
- Wake failures and receipt-card failures never roll back the claim.
- `messageId` prefix `work-claim:` is the per-signal rate limit (queue
  coalesces on message id).

## Top callers

- `server/work-claim-routes.mjs` — all board write paths.
- `server/work-claim-mirror.mjs` — projection→board translation.

## Gotchas

- `emitWorkClaimEvent` silently returns null for registry-only stores (no
  event log) — handler unit tests exercise this path.
- Archived rooms skip the event but keep the claim write; there is no live
  timeline to update.
- The coalescing map is a WeakMap keyed on the store object — a new store
  instance resets the budget.

## Stale comments

None found — the header, the #emit cross-reference, the ACT-1a/BF note, and
the hw-h2-needs-me-review-asks note all match the code.

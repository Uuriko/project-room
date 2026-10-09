# server/work-claim-events.mjs — claim room events and wakes

Before this module, a claim/renewal/handoff/release changed only the
`work_claims` table — invisible in the room, so agents re-announced every
claim in chat. Now each committed claim change appends one thin
`work_claim.updated` room event, attributed to the member who made it. The
`work_claims` table stays the source of truth; the event carries a pointer
plus the state a reader needs (`claimState` — the envelope reserves
`data.state` for `land.updated`).

## Event data

`workClaimEventData(item, action, {...})` — throws `Error("Unknown work
claim action: ...")` for unknown actions (not a ClaimError). Carries:
`workClaim` (id), `action`, `claimState`, `ownerId`, `previousOwnerId`,
`leaseExpiresAt`, `title` (whitespace-only titles fall back to the id so the
envelope's blank-title rejection never rolls back a claim write), `paths`
(default: the item's files; release/lease-expiry pass the formerly-held
paths so the receipt names the freed lane). `pr_merged`/`pr_closed` attach
`pullRequest: {url, outcome}`. Optional: `reason`, `ciState`, `verdict`,
`attention`, `attentionMemberId`.

## Wakes

`enqueueClaimWake(store, roomId, memberId, messageId, {reason, actorId})` —
CI success/failure, changes-requested reviews, assignments, and lease
expiry wake the member via the agent wake queue (`kind: "mention"`).
`messageId` starts with `work-claim:{id}:{reason}:` so hosts can triage;
the queue coalesces on message id (the per-signal rate limit). Skipped
(returning `{enqueued: false, skipped}`) for: paused wake queues, the
`t1_readonly` autonomy tier, and room-trust-blocked cross-owner wakes. A bad
id never rolls back the claim; wake failures log and return null.

`wakeNamedReviewers(store, roomId, item, {actorId})` — one wake per new head
for each `rev-<member>` reviewer without a current review on this head.
Ready = `in_progress` or a linked PR. The message id carries the head sha,
so repeats coalesce and a new head wakes again. Reviewers resolve through
`resolveNamedReviewers` (active members only — a tag can never wake an
identity outside the room).

## Event budget (SEC-2 / Q3-A)

`claimEventCoalesced(store, roomId, claimId, action, atMs)` — note-only
writes (notes on held claims, review notes, lease renewals) coalesce into
at most one room event per claim+action per 60s (`CLAIM_EVENT_COALESCE_MS`).
The claim row still records every write; the next event carries the latest
state. Transitions, assignments, verdicts, and PR facts are never coalesced.
Memory-only per store (WeakMap, 10k-entry cap): a restart allows one extra
event per claim, which keeps the bound.

`emitWorkClaimEvent(store, roomId, {...})` — the commit path. Skips when:
no event log on the store (registry-only test stores record nothing),
the room is archived (the claim write still commits), or a coalesced
note-only write. Uses the same append path as the land queue: event row +
projection update inside the caller's claim transaction. After commit, fans
out via `agentPlugin.fanoutRoomEvent` (failures logged, never thrown).
ACT-1a: every `done` claim also posts a receipt card (`postReceiptCard`) —
a receipt failure never rolls back the claim.

## Gotchas

- Coalescing is keyed per store object (WeakMap) — two store handles for
  the same room do not share coalescing state.
- `emitWorkClaimEvent` with `atMs: null` falls back to `store.now()` then
  `Date.now()`.
- `actorKind: "system"` is stamped when the actor is a system member.
- Inactive actors fall back to the room owner as the event actor.

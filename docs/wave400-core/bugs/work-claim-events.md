# Suspected bugs — server/work-claim-events.mjs

Flagged, not fixed. All in `server/work-claim-events.mjs`.

- `:emitWorkClaimEvent` — the archived-room early return happens *after* `claimEventCoalesced` is consulted but the `noteClaimEvent` write at the end is skipped on the archived path; consistent, but the coalescing check itself runs against a room that will never emit — harmless, noted for clarity.
- `:enqueueClaimWake` — `messageId.split(":")` parsing assumes the `work-claim:{id}:{reason}` shape; a caller-passed id containing extra colons shifts `parts[2]` (reason) — the derived reason could be wrong while the wake still fires.
- `:wakeNamedReviewers` — `head` falls back through `ci.headSha ?? revision ?? claimedAt ?? "none"`; two different heads that both lack all three fields share the message id `"none"` and coalesce into a single wake, so a reviewer may never be woken for the second head.

Checked and clear: event/claim atomicity via caller transaction, archived-room skip, wake failure isolation, receipt-card failure isolation, coalescing window math, attention propagation for paused assignees.

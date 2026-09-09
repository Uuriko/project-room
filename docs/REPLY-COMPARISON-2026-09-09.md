# Reply comparison in the existing composer

## Decision and research

The preceding durable update checkpoint made progress; the whole goal remains incomplete. Current source is clean at `e91eac2`, runtime `29fe7d7`, schema23. Deployment has not been requalified and is not changed by this work.

Microsoft describes a successful message update as a 200 response with the updated message object. A later GET is different evidence. The `changeKey` is a version, not a documented sortable sequence. This supports separate write acknowledgment, observed content and review records; it does not establish conditional-write or retry safety. [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [Message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).

Provider receipt/resolution qualification remains necessary before enabling updates. A useful read-only comparison does not need that write authority. Refine the previous sequence accordingly: make the three versions understandable now, without presenting a comparison as approval or execution. No mailbox or authenticated provider was accessed for this research.

## Interaction plan

Keep one existing Review reply entry and sheet. Show recorded mailbox content normally. If local writing differs, label the action Compare reply and reveal a second text region; put the original creation text behind Original draft. On narrow screens, stack the versions instead of squeezing two columns. Show recipient context once above the mailbox text. Preserve multiline writing and keep an explicit close/return action. Do not overwrite or save either version merely by viewing it.

Use a new explicitly negotiated read projection on the existing private review route. Older clients retain v1 without additional private history. V2 adds only the original body and a bounded child-update status, not provider IDs, request descriptors, raw mail headers, transport responses or credentials. The current local text comes from the existing composer, including unsaved edits; do not substitute a delayed server copy for it.

Comparison cannot grant review to a stale creation plan or a pending update. After account/source changes clear all displayed text. If local writing changes while the sheet is open, preserve the captured comparison and require reopening; do not silently replace text being reviewed. Unknown child updates remain explicitly unknown, even if readback content matches.

## Verification plan

Verify v1 compatibility, strict v2 validation, account boundaries and no shared-log writes. Exercise identical/different/empty/long/HTML/unavailable previews, pending update status, unsaved text, late responses, account replacement, close/reopen and direct versus room-assisted replies. Inspect desktop/mobile screenshots. Qualify the exact committed runtime with core and affected browser/Workers checks. These simulate human behavior and do not establish delight or retention.

No provider write, sending, new update command, migration, model, payment, push or deployment is part of this slice.

## Implemented locally

The existing `reply-review` route negotiates `reply-review-v2`; v1 keeps its original response shape. V2 adds the original creation body and a bounded pending-update status. The browser validates both and refuses a pending-update response that claims review authority. No provider identifiers, write descriptors or credentials enter this additional projection. Schema remains 23 and runtime inventory remains 81 files.

The sheet keeps one body when text matches. When text differs, it shows the recorded mailbox draft beside the user's current local writing, including unsaved or empty text. Local text is captured on opening, rendered inertly, and never substituted with a delayed saved version. Original draft is closed by default and reset on reopening. Pending updates remain not-started or unconfirmed; the comparison grants no update, retry or sending authority.

The first visual pass showed a disabled blue review button competing with a read-only comparison. It is now hidden when review is unavailable, leaving Keep writing as the clear return action. That action preserves the text and focuses the private composer. The initial close tests also exposed asynchronous dialog-close cleanup: the button now clears preview content immediately, and an old queued close event cannot erase a newly opened preview. Rapid close/reopen is explicitly tested.

The first focused comparison run passed six of eight checks and failed immediate post-close clearing in both layouts. The corrected focused run passed all eight. Subsequent broader checks passed 896 core, 62 affected browser checks and 24 local Workers checks before the final extra visible-sign-out and rapid-reopen tests were added. Final committed results are recorded below after verification.

No actual-human preference, provider interoperability, retention or deployment readiness is inferred from these results. Provider write acknowledgment/resolution remains a separate unfinished milestone; this turn researched its distinction from readback but did not implement or persist a write receipt.

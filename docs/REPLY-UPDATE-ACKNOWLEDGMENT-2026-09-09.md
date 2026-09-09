# Reply update acknowledgment

## Scope and decision

This advances the private reply journey described in the Project Room blueprint, without adding a second messaging surface. The preceding comparison checkpoint was clean at 297dff7, runtime 0713606, schema23. That milestone made progress; the ambitious product goal remains active and incomplete. This checkpoint is local qualification, not a deployment or a live-mail capability.

Microsoft documents a successful message update as HTTP 200 with an updated message object. A later read of matching text is not evidence that our operation caused it. Its message version is opaque, and this work does not assume atomic conditional writes or safe resubmission. Sources, researched during the preceding comparison milestone: [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0), [Message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0), [Immutable identifiers](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

Keep three separate facts: a specific update was acknowledged, particular content was observed, and that content was reviewed. The fixture-only driver can now retain the first fact. It never converts the first two facts into the third.

## Implemented

The trusted private driver classifies a PATCH response against a retained update proposal. Acknowledgment requires status200, immutable-ID mode, exact connection/account context, the retained draft ID and a bounded opaque provider revision. Non-success, missing responses and GET/readback matches do not acknowledge a write. Wrong mailbox or draft identity is rejected. Arbitrary response bodies, headers and credentials are stripped before journaling.

The immutable acknowledgment command refers to the exact earlier dispatch request, not merely the mailbox draft. The account-scoped receipt must match child ID, parent, source, proposal, dispatch state/revision and dispatch timestamp. Replay reconstructs this relationship using only earlier validated dispatches. A missing, different or future dispatch cannot justify the receipt.

Unlike a content observation, this operation fact does not carry an expected current child revision. A legitimate write acknowledgment can arrive after newer readbacks; discarding it as stale would lose evidence, while applying its response body would overwrite newer evidence. The transition increments the current child revision and preserves its existing observation, parent and local text. Exact request retries return the original receipt. A different competing acknowledgment cannot create another transition.

The child becomes update_acknowledged, but remains unresolved. Further observations preserve the acknowledgment. Observation equality still reports no causal proof. Automatic execution, retry, review and sending remain false. Cancellation remains available only before dispatch. Parent review and replacement updates remain blocked pending a qualified child-specific review/resolution lifecycle.

Current account authentication is still required, including when returning an exact duplicate receipt. Disconnection does not erase the historical operation: the same authenticated account may record a late acknowledgment against the retained connection. The one acknowledgment remains recordable at the pilot command cap so capacity cannot suppress an in-flight result; this does not authorize new updates beyond that cap.

## Quiet presentation and compatibility

The existing private reply-review route now explicitly negotiates v3. It exposes only the additional acknowledged status, not dispatch IDs, provider revisions, transport plans or raw responses. V1 stays unchanged. V2 retains its bounded vocabulary: acknowledged-but-unreviewed work remains an unresolved completion (update_unconfirmed). V3 distinguishes the write acknowledgment from pending review. This is a conservative legacy projection, not a claim that no provider response exists.

The same comparison sheet says “Update acknowledged · review pending.” The old content is labeled “Last checked draft,” rather than implying it was fetched after the write. Original draft stays collapsed; local writing remains separate; Keep writing stays the single primary action when review is unavailable. Desktop comparison columns stack on mobile.

A review action now checks the entire captured comparison basis and current review permission, not only the parent ID/revision. The regression fixture reserves an update without changing the parent version, refreshes the open sheet and verifies both a disabled button and refusal of a queued click. Server-side review blocking was already present.

## Schema and recovery

Schema24 retires older writers before they can append history they do not understand. There is no new table or runtime asset. Pre-v24 acknowledgment actions, receipt fields or states cause migration to roll back for operator reconciliation. Legitimate v23 child histories migrate byte-for-byte before accepting a late acknowledgment.

Tests exercise earlier genuine runtime versions, migration rollback, a cached old writer, populated v23 in-flight children, cold allowlisted packaging, duplicate receipts, concurrent connections, missing/wrong dispatches, response scope, unknown results, current authentication, disconnection, capacity, read-only calls, journal rollback and rewritten receipts. Local Cloudflare tests carry an observed child through acknowledgment and another restart. They do not contact Microsoft's service.

## Verification record

Initial local-only acknowledgment tests found a test-fixture reference error in the logout check; the corrected test derives the actual session revision. Initial full focused tests hit a sandbox localhost-listener permission failure. The permission service also timed out before starting a process; a narrower browser run subsequently received permission. These are retained as execution/fixture issues, not product interoperability evidence.

Before the final last-checked label, refresh regression and extra rollback test, the working tree passed 905 core, 65 affected browser and 25 local Workers checks. The final focused desktop/mobile acknowledgment and refresh regression run passed three cases. Exact committed verification follows below; these preliminary counts are not substitutes for it.

Screenshots use fictional mail. Simulated human journeys cannot establish real-user delight, retention or live-provider compatibility.

## Next

Finish post-write inspection with a child-bound review basis, including observations before/after a late acknowledgment and opaque version mismatches. Add explicit reconciliation and terminal resolution without treating equality as causation, without silently replacing local writing, and without making uncertain updates repeatable. Qualify the full interaction in the existing comparison sheet before exposing an update control.

Then qualify an authorized dedicated mailbox and an actual transport under explicit scope. Provider concurrency, permissions, recovery, credential handling, delivery and operational release checks remain necessary. This checkpoint does not enable provider calls, external sending, paid models, money, publishing or deployment, and does not change Desk, Dasha or Demigod.

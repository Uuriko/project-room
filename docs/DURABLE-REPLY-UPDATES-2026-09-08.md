# Durable reply updates: implementation and verification

## Bounded implementation

Reuse the private Inbox command journal for child update attempts. The original creation plan and its observations remain unchanged. Reserve an exact current proposal, cancel only before dispatch intent, record dispatch intent before any future external operation, and retain normalized readback evidence against the immutable child proposal.

The pilot has three lifecycle states: `reserved`, `cancelled`, and `update_unconfirmed`. Readback is separate evidence, not a terminal state. Matching content cannot prove which actor wrote it or that a delayed write has finished. Therefore a dispatched child continues to block replacement, automatic retry, and the old creation-only review flow. No forced-resolution shortcut is included.

Reservation reconstructs the current proposal from authenticated account, source, saved draft, original attempt and connection. Dispatch reconstructs it again. Both use the complete version-bound proposal; no caller-provided write descriptor is accepted. A no-op cannot reserve. Only one non-cancelled child may exist per creation attempt. Cancellation remains possible after edits or disconnection because it makes no outside claim.

Readback uses the retained child identity and connection. It can record evidence after local edits, account reauthentication or disconnection, but requires current private-account authority. Its expected child revision must be captured before the read. Stale observations cannot replace later child evidence. Child evidence never overwrites the parent's observation or newer local writing.

## Implementation order

1. Add exact child transition validation and normalized comparison to the existing reply modules.
2. Add private history, recording and deterministic replay to the existing Inbox service. Keep provider transitions off HTTP/MCP commands.
3. Retire v22 writers with schema23 and reject pre-existing collisions in the new receipt/action namespace before migration.
4. Verify no-op, duplicate requests, competing connections, interruption, stale drafts/observations, changed authority, rollback, backup, cold package, genuine old-runtime migration and local Workers restart.
5. Run core and affected browser regressions. Preserve visual evidence for the unchanged reply UI; do not label it a new update interaction.

## Deliberate limits

No provider transport, write acknowledgment qualification, automatic retry, terminal resolution, new UI, public provider-write endpoint, sending, model execution, payment, push or deployment. Fixture dispatch is only a durable intent marker and never grants execution permission. A future live adapter must enforce separate authority and invoke at most from the winning nonduplicate transition. Conditional provider updates and post-dispatch resolution remain separately qualified work.

The next UI should reuse the focused comparison sheet, not add another inbox or always-visible version editor. Before enabling it, finish write-receipt/resolution semantics and bind review to the selected child and observation rather than the old creation plan.

## Verification

The implementation uses the existing reply modules and `private_inbox_commands` table; no new runtime asset or dependency. `replyUpdates` returns authenticated account-private child history. `recordReplyUpdateObservation` strips a supplied fixture response into normalized evidence before recording it. General browser/agent command routes reject child transitions. The existing compact review projection omits child plans and refuses an old review while an update is pending.

Schema23 retires earlier writers even though there is no new table: v22 cannot interpret the child receipt namespace. Migration checks for pre-existing namespace collisions before writing. Genuine frozen v22 packages join the existing Node and local Workers upgrade/rollback coverage; their prior reviewed draft state must remain reviewed, not be downgraded to the older fixture's unconfirmed creation state.

Testing reproduced a separate storage inconsistency: Node's `readTransaction` previously used a deferred transaction but allowed nested writes, whereas the Workers adapter rejected them. Node now rejects nested service writes and uses SQLite query-only mode for an outer read transaction, restoring the previous mode on success or failure. Reads inside an existing write transaction retain the outer transaction's authority. Tests cover both service calls and direct SQL writes; this is an internal consistency guard, not a sandbox against code with database-administrator access.

The first existing-reply regression run passed 55 of 56 tests and caught the package validator's missing schema23 allowance. The first new lifecycle run also exposed one missing test session binding and the genuine read-transaction bug. A subsequent reauthentication fixture needed to retain its response before revoking the old session. These are recorded separately from production fixes.

The broader pre-commit run passed 895 of 896 core checks, 57 account/Inbox/collaboration browser checks, and 24 local Workers checks. The one core failure was a migration assertion assuming every old fixture ended at `creation_unconfirmed`; the genuine v22 fixture already contained a reviewed draft. The assertion now checks the exact retained fixture state, and additionally requires that v22 review remain current. No production validation was relaxed for that failure.

Exact committed results and retained screenshots will be recorded after final verification. Screenshots document the unchanged fictional reply flow, not a new update button. The actual update lifecycle is tested through the private service and across Node/package/Workers restarts; human usability and live-provider behavior are not established by these tests.

Runtime `29fe7d7e8ef4763ac5a851b9d9a15b4ead2599b4` passed **896 core** and **24 local Workers** checks, zero failures. The Workers suite exercises real local adapter migration and multiple restarts with retained child dispatch and matching readback; it is not a hosted deployment check.

The first committed browser run passed 56 of 57 checks and failed an older privacy assertion in the mobile sharing scenario. That assertion searched the whole serialized room snapshot for the bare number `4200`, which can also occur in public identifiers. The failing snapshot was not retained, so its exact matching field is unknown; no private-content leak was established. The test now checks the exact unshared budget paragraph, sender address and local reply text, with an intentionally similar public identifier to demonstrate that metadata matches are harmless. This changes the test, not the sharing implementation. Final browser rerun evidence follows below.

Evidence is retained under `test-results/durable-reply-updates-20260908/`, including the initial browser failure rather than only passing runs.

# Edited reply: preserving three versions

## Implemented locally

The provider-reply module can now prepare and revalidate a **body-only update proposal** from an authenticated private account, the saved local draft, the retained creation attempt and the latest recorded mailbox observation. It can compare a supplied readback against that proposal without changing any stored record.

This is the first implementation slice of [the existing update plan](RESEARCH-TO-BUILD-NEXT-2026-09-08.md), not a complete update feature or a live adapter. It closes a necessary gap between editing a local reply and eventually updating the already-created mailbox draft. Creation history remains immutable; a local edit is not presented as a new creation attempt.

The preceding goal turn made progress by implementing and verifying Results. The full product objective remains active. This checkpoint does not complete real messaging, execution, rewards or deployment readiness.

## Research recheck

Microsoft's message-update documentation specifies PATCH, Mail.ReadWrite, body edits on draft messages, omission of unchanged fields, and a successful 200 response with a message object. It does not document an atomic If-Match precondition for this operation. That omission does not prove conditional updates are unsupported; it leaves their behavior unqualified for our adapter. [Microsoft: Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0).

Immutable IDs require the corresponding Prefer header on relevant requests and remain tied to the documented mailbox conditions. We retain that header and the original mailbox/draft identity rather than deriving a new draft destination. [Microsoft: Immutable Outlook identifiers](https://learn.microsoft.com/en-us/graph/outlook-immutable-id).

Product decision: prepare the body-only change but keep execution disabled. Do not invent an If-Match guarantee, treat an opaque provider revision as a sortable counter, or interpret matching content as proof that our update caused it. No provider account was accessed during this recheck.

## The comparison contract

| Version | Meaning | Preservation |
| --- | --- | --- |
| Original | Content and recipients intended when the mailbox draft was created | Copied from the immutable retained creation plan |
| Observed | Latest recorded mailbox draft, including outside edits | Kept independently with its observation and provider versions |
| Proposed | Observed non-body context plus the current saved local body | Never substitutes for either earlier version |

Outside recipient and subject differences remain explicit in `contextDifferences`. The proposal does not repair, accept or rewrite those changes. Changed From, Sender, thread, draft state, unsupported body representation or incomplete/nonempty attachments cannot enter this pilot. Recipients must remain nonempty. The later comparison UI must show consequential context before any explicit update or review.

Only the body is included in the proposed PATCH payload. If observed and proposed text already match after line-ending normalization, the result is `no_update` with no PATCH descriptor. Raw text remains preserved in all three versions; normalization is only an equivalence check.

The proposal binds account/auth epoch, source version/revision, local draft revision, attempt revision, original creation-plan version, canonical connection profile/revision, confirmed provider draft ID and observation version. Revalidation rereads current authorized state and reconstructs the whole proposal. A caller-recomputed digest, extra authority flag, changed body/header or different draft ID cannot bypass that comparison.

The request descriptor contains no credential. `canExecute`, `canRetryUpdate`, `canReview` and `canSend` remain false. Conditional writes are explicitly unqualified.

## Functions and boundaries

The existing `server/graph-reply-draft.mjs` now exports:

- `prepareGraphReplyUpdate`: authenticated, read-transaction preparation from the retained attempt.
- `buildGraphReplyUpdate`: pure construction for trusted current inputs; useful for the next journal/replay stage.
- `currentGraphReplyUpdate`: full reconstruction and comparison, including JSON-round-tripped proposals.
- `inspectGraphReplyUpdate`: current authorized proposal plus supplied readback.
- `compareGraphReplyUpdate`: pure comparison for caller-authenticated evidence; not an authorization boundary.

Readback can be unavailable, match the proposal, retain the observed content, or need further review. Provider revisions are compared only for equality. Every outcome retains `updateOutcome: "unproven"` and false execution/retry/review/send flags. A content match does not confirm dispatch, prevent a subsequent outside edit, acknowledge review or prove delivery.

There is no new HTTP endpoint, browser action, database migration, runtime asset, dependency or network call. Schema stays at 22 and the allowlisted runtime remains 81 files. The original attempt remains unresolved according to the existing journal; this code cannot release it or create a replacement draft.

## Evidence

Twenty-one focused update cases cover three-version preservation, no-op behavior, exact serialized reconstruction, outside header edits, unsupported observations, phase gates, stale attempts, changed local/source/account/connection context, unchanged observation revisions, opaque provider versions, wrong identities and cold-package reconstruction. Audit digests before/after qualification and comparison establish no database changes in those cases.

The initial combined run passed 73 checks across update qualification, existing draft creation and the durable reply journal. Code review then removed a redundant undefined connection-revision field; the canonical connection profile already carries its revision. The added JSON round-trip test protects that boundary. No production validation was relaxed.

Evidence directory: `test-results/reply-update-20260908/`. `three-versions.json` contains generated fictional comparison data, not real mailbox content or credentials. There is no new UI to screenshot in this slice; any existing composer screenshots from regression checks remain evidence for that unchanged interface, not an update button.

Exact committed test results are recorded below when complete.

Runtime commit `05adfd3c59ce33db9fda73368dc81622aa54f032` passed **878 core**, **57 account/Inbox/collaboration browser** and **23 local Workers** checks with zero failures. Logs: `committed-core.log`, `committed-browser.log`, `committed-workers.log` in the evidence directory. The new functions are directly exercised in Node and the cold Node runtime package; the Workers suite guards the existing runtime, not a nonexistent Workers update endpoint. The browser run includes unchanged direct and room-assisted reply journeys on desktop/mobile. Subsequent edits to this checkpoint are documentation only.

The committed browser run's unchanged desktop/mobile final reply screenshots were retained as `unchanged-desktop-reply.png` and `unchanged-mobile-reply.png`; the mobile image was visually inspected. These show the existing fictional local reply flow, not a new mailbox-update interaction.

## Next implementation, without widening authority

1. Add child update-attempt records under the original creation attempt. Keep preparation, dispatch intent, provider evidence and observations distinct. Define cancellation before dispatch versus uncertainty after dispatch.
2. Implement deterministic replay, migration and old-writer retirement. The winning nonduplicate dispatch transition alone may call a future adapter; unknown outcomes must not automatically replay a PATCH.
3. Preserve late evidence for its own immutable operation without replacing a newer proposal or approval. Current-proposal validation and historical-evidence recording need different entry points.
4. Reuse the private composer/review sheet for original/observed/proposed comparison, explicit update intent and recovery. Test both direct replies and room-assisted replies.
5. Qualify conditional writes, native body representation, outside-client edits and final-read-to-send behavior in a separately authorized dedicated mailbox. Do not enable actual sending as a side effect of draft-update work.

No live mailbox access, sending, model execution, payments, push or deployment occurred.

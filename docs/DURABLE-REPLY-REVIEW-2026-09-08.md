# Durable provider-draft review

## Decision and boundaries

Finish the private source → room assistance → reviewed reply loop before adding more integrations. This checkpoint adds durable fixture observations and account-bound content acknowledgments, not a mailbox transport, public API, UI control or permission to send. The existing composer remains the intended home for later controls; no new navigation surface is needed.

The key distinction is between a historical review and a current authorization. Preserve the former; never infer the latter. All reply attempts remain `canSend: false`.

## Research and implications

- Graph exposes a message `changeKey` and distinguishes `isDraft`, sender, From, recipients and attachment relationships. A false `hasAttachments` alone does not exclude inline attachments. Therefore compare a complete, version-bound attachment observation, and retain exact message versions rather than a permanent “reviewed” badge. [Message resource](https://learn.microsoft.com/en-us/graph/api/resources/message?view=graph-rest-1.0).
- Reading a message supports selecting properties and requesting text bodies. An unavailable read is not evidence that a draft was deleted or never created. Continue requiring an explicit immutable-ID context and the retained creation receipt. [Get message](https://learn.microsoft.com/en-us/graph/api/message-get?view=graph-rest-1.0).
- Draft subject, body and recipients may be edited. Explicit review should accept supported visible differences rather than insist that provider text exactly equals local text. Identity, draft state, unsupported HTML and incomplete attachments remain blockers. [Update message](https://learn.microsoft.com/en-us/graph/api/message-update?view=graph-rest-1.0).

These are conservative product decisions based on documentation, not claims about live-provider qualification or atomic send guarantees.

## Implementation plan

1. Reuse the existing private Inbox command journal. Persist only bounded normalized observations, not arbitrary provider response fields. Extract a deterministic comparison shared by inspection and history replay.
2. Add `reply.observed` and `reply.review`. Every request binds the source, retained attempt, expected attempt revision and stable request ID. Capture the expected revision before reading the provider: late results cannot silently rebase onto newer state.
3. Record unavailable observations explicitly and invalidate review. Changed exact versions invalidate review even when visible text matches; an identical observation may retain it within the same account authority epoch.
4. Review requires the exact current observation version, current source/local draft/connection/account authority, fully observed plain text, correct sender/thread/draft identity, and complete empty attachments. To/CC/Bcc, subject and body differences can be explicitly acknowledged; this is not send approval.
5. Keep immutable historical reviews after local edits, while the authenticated read projection reports whether they still match current intent. No room member or agent token gains private mailbox access.
6. Advance the writer fence to schema 22 without adding a table. Preserve older history verbatim, reject pre-22 namespace collisions, and test actual v21 → v22 data upgrades, rollback and cached-writer retirement on Node and local Workers.
7. Qualify retries, stale reads, review invalidation, unsupported content, authority changes, capacity, concurrent writers, reopen, backup and audit replay. Run core and Workers suites and a proportionate browser regression. Record exact evidence and limitations before committing.

## Next product slice

Once this service boundary is qualified, expose a compact fixture-only preview/review in the existing composer. Show recipients and content, with advanced metadata collapsed. Use “Review changes” only when action is needed; keep transport unavailable until separately authorized provider qualification. Do not describe fixture review as a live integration.

## Implemented contract

The existing journal now retains normalized observations and version-bound reviews. Observation inputs are limited to 32 KiB, within the existing 5,000-command account pilot capacity. No table, public route, provider dependency or new runtime module was added. Invalid input and failed writes leave history unchanged; a valid unavailable observation clears the current review. At capacity, observations/reviews are refused, while existing cancellation/creation-outcome cleanup remains available.

Review is an account-session content acknowledgment through the fixture service boundary. It is not proof that a person actually saw a UI, a send grant, or a claim that a provider message has not changed since the last read. The authenticated attempt projection supplies `reviewCurrent` for retained reviews: false after a changed local source/draft, disconnected connection or changed account authority. The historical status/receipt stays intact. Exact duplicate requests return the original receipt, not a fresh approval.

The future live driver must capture `expectedRevision` before each provider read, retry only the exact recorded request, and issue a fresh read after a conflict. It must not treat an older retained review as current remote evidence after a failed, malformed or over-limit read. A last-read-to-send race remains unresolved; no atomic conditional-send guarantee was established. Every state still reports `canSend: false`.

## Qualification evidence

Local evidence is retained under `test-results/reply-review-20260908/`. The initial core run passed 851 checks, including 18 added review/history/concurrency cases and the genuine v21 upgrade. The local Workers run passed 23 checks, including a second process restart recovering a reviewed provider draft, exact retry, and unavailable-read invalidation. The standard recovery fixture now also contains an observed and reviewed draft for future recovery/package checks; the frozen v21 baseline retains its original pending attempt.

Desktop and mobile screenshots show the unchanged fixture Inbox, inspected for layout and content separation. The deliberately literal image-tag text is synthetic reader-test content, not a loaded remote image or a new UI. There is no new review control visible yet.

The final edited recovery fixture and upgrade assertions passed a second full core run: **851 passed, zero failures** (`core-final.log`). The focused account/Inbox/collaboration browser regression passed **49 checks, zero failures** (`browser.log`). Workers evidence is **23 passed, zero failures** (`workers.log`). These runs qualify local synthetic behavior only, not real-person usability or a connected mailbox.

No live provider access, external message, AI execution, money movement, push or deployment occurred. This is a local schema-22 candidate; old live/staging evidence does not certify it.

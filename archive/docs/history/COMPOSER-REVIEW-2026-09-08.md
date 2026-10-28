# Private reply review in the composer

## Outcome and design choice

The existing Inbox can now show a recorded sample mailbox draft and acknowledge its exact content version. The normal private draft is preserved. This is the next user-facing step after [durable provider review](DURABLE-REPLY-REVIEW-2026-09-08.md), not a live email integration.

We considered a permanent provider-details panel and a focused review sheet. Chose the sheet: provider state is secondary until a draft actually needs inspection, and a sheet keeps recipients and content together without taking space from every ordinary conversation. No new destination, setup wizard, agent requirement or paid feature is introduced. This is a reasoned design choice, not a measured preference from human participants.

The sheet uses one dominant action, **Mark reviewed**. From, To, CC and BCC are visible together; Sender appears separately when different. Metadata does not hide recipients. Subject and complete plain-text body lead the content; provider identifiers and transport plans stay private to the service. Sample and not-sent status remain explicit. Unsupported HTML is never rendered. Escape/Close returns to the same Inbox draft.

Controls appear only for a retained attempt. Existing email fixtures without one, ordinary private sample messages and room chat keep their prior flow. A known reviewed version uses **View reply**. Changed or unavailable state cannot be acknowledged under the old version.

## Service and client contract

- `GET /api/inbox/sources/:id/reply-review?view=reply-review-v1`: explicitly negotiated, account-cookie/binding protected, no-store, one current attempt projection or null. The response excludes the creation plan, provider draft ID, source-message ID and normalized source envelope.
- `POST /api/inbox/review`: accepts only the exact existing `reply.review` operation under account-session, origin and CSRF checks. Returns a narrow immutable receipt with request, attempt, revision and review version. Ordinary room/agent bearer keys do not grant access.
- All reserve, dispatch, creation and provider-observation writes remain behind the fixture service boundary. The general Inbox command endpoint still rejects them, including direct review submission through that endpoint.
- Reviewable content uses the same predicate as durable journal replay. Historical and current review checks share one local-intent validator. No database migration or new runtime asset is needed; schema remains 22.
- A lost acknowledgment retains only request metadata in per-tab storage. The user explicitly chooses **Check review** to retry the original operation. Reload never creates a new review or grants sending. If storage fails, the UI asks the user to keep the tab open.
- Source/draft edits, stale attempt revisions, another tab's review and account changes cannot silently replace the viewed basis. Async results are tied to account ownership, source, generation and modal/read turns. Reset clears private rendered content.

## Local sample and tests

The explicit local sample launcher includes a fictional mailbox review when started with `--start`. Its programmatic `includeEmailReview` option defaults off to preserve existing sample callers. The fixture seeder is not included in the production runtime package and performs no provider I/O. Account-only Inbox use can complete this sample without entering a room or creating work.

Tests exercise desktop/mobile preview and acknowledgment; visible CC/BCC; preserving the private local draft; reload; lost acknowledgments and exact retries; provider/local edits; unavailable/HTML drafts; late reads after another tab changes account; competing browser reviews; account-only sample use; request/receipt validation; cross-account, bearer, CSRF and session-binding refusals; and the same narrow HTTP operation on local Workers.

The existing desktop/mobile room-assisted journey also extends through the new sheet: a selected private email excerpt becomes room work, an independently reviewed result returns as a private draft, a deliberately seeded provider observation retains that exact draft body, and the user separately marks its preview reviewed. The source-to-room boundary stays selective and no provider submission occurs. The fixture step is labeled, not disguised as real transport.

Screenshots and logs will be retained under `test-results/composer-review-20260908/`. These are simulated-human journeys and synthetic provider records, not evidence of human delight, retention, real mailbox interoperability or deployment readiness.

## Remaining work, without widening the interface

1. Qualify editing/reconciliation of an already-created draft. Currently a local edit correctly makes the old provider draft non-current, but this checkpoint does not patch that provider draft or release unresolved creation attempts. Preserve both versions rather than silently replace either.
2. Add a bounded fixture driver for explicit update/readback and recovery using the retained provider identity, without enabling general provider-write commands in the browser.
3. Rehearse the complete room-assisted draft → provider edit → exact review path, including failed updates and stale replies. Then choose a separately authorized dedicated mailbox pilot.
4. Resolve Graph body-representation and last-read-to-send limitations before offering real sending. A plain-text returned representation does not establish exact outgoing MIME/HTML content; a reviewed version is not an atomic send precondition. See the prior document's official sources.
5. Maintain the broader roadmap: actual agent/manual parity and bounded execution remain important, followed by separately qualified rewards and wider messaging. This checkpoint does not complete the overall goal.

No live mailbox access, external sending, model execution, payment, push or deployment is part of this work.

## Verification record

The edited runtime passed 853 core/cold-package/recovery checks. A broader account/Inbox/collaboration browser run passed 57 checks, and 23 local Workers checks passed. After extracting the shared current-review validator and extending the full collaboration journey, the focused final browser run passed 10 checks, including both integrated desktop/mobile journeys. Post-commit verification is recorded separately below when complete.

The initial Workers HTTP fixture failed because it tried to retrieve an account before creating/binding one; the test fixture setup was corrected and its rerun passed. Keep both logs as evidence rather than hiding the initial failure. Desktop/mobile review screenshots were visually inspected for readable recipients, natural wrapping, one primary action and unchanged surrounding navigation.

Exact committed runtime: `2e2c9884169410ee4aa8ca92d11c9b395bc30992`. Post-commit verification completed with **853 core**, **57 account/Inbox/collaboration browser**, and **23 local Workers** checks passing, zero failures. Logs: `committed-core.log`, `committed-browser.log`, `committed-workers.log` in the evidence directory. The browser pass includes the full room-assisted reply review on desktop and mobile. Subsequent changes are documentation only; schema remains 22, runtime package remains 81 files, and the overall product goal remains active.

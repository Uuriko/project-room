# Conversation to useful result

## Outcome and boundaries

A person asks in chat, another person adds a constraint, an agent works, both people can use the result and either can reply to revise it. Returning later preserves the conversation, attribution and current result. Chat is the default; focused work and result details appear on demand. This is one collaboration flow, not a new dashboard or task system.

Start from local 7620ffa6 above PR4260/4244/4243. Retain the completed room-only navigation, exact-result copy/download, draft-safe room return and phone timeline fix. Inbox/email integrations remain excluded from v1. Email authentication and agent coordination remain supported. No scheduled work; public notarized Mac distribution remains deferred.

## Architecture

Keep three existing boundaries explicit:

* Conversation messages are the attributed source of requests and changes. Ordinary multiplayer chat stays ordinary. Addressing Room or replying to its recorded conversation establishes intent; the server decides authority.
* Assistant runs record execution attempts and pending/applied inputs. A completed run stays immutable. A follow-up uses a new execution in the same conversation, with the prior result explicitly referenced; it does not reopen an old attempt or create an unrelated project task.
* Work receipts retain exact submitted versions and review state. An ordinary assistant answer is not relabeled a verified result. Native result actions remain pinned to their receipt.

Human UI owns presentation and composer navigation. The shared host owns bounded execution context. Existing APIs own authentication, visibility, revisions, idempotency and cancellation. Avoid new durable tables, speculative summaries and duplicate state caches.

## Implementation sequence

### 1. Reconcile and retain current work

Read claims and branch/CI status before edits. Current remote PR4260 is ab2e986b; local email-removal commits are not yet pushed. Preserve parent ancestry and coordinate independent account/onboarding carriers with the release owner. Do not merge a red stack simply to begin product work. Keep a single source branch for this slice and submit its verified head for integration.

### 2. Make progress useful and compact

Keep the current run attached to its source message. Add the latest nonempty recorded progress summary below its state, bounded for layout; never manufacture activity or treat silence as completion. Keep questions, conflict resolution, stop/recovery and streamed answer text visible. Avoid repeating a status word as an activity summary. Keep the live announcement region stable and update only on actual state/text changes.

In expanded Work history, remove duplicated status/result snippets already shown in the row summary. Preserve attributed additions, their pending/applied state and distinct history entries. Retain keyboard focus, disclosure state and current scroll position across updates.

For work cards, show accountability compactly beside the title. Show a next-step instruction when it requires attention, not a second sentence explaining that completed work is complete or working work is working. Do not hide blockers, unresolved decisions, unknown state or required review.

### 3. Reply directly to the result

Add one contextual Reply action next to Open result on a completed assistant run. Reuse the existing composer and reply target. Preserve draft text, uncertain-send ownership, channel/thread identity and authorship. Disable/refuse a reply for missing, deleted, private or archived-channel messages; do not silently route to a different message. Do not add a second revision form.

Use the same composer navigation routine as the exact result reader. Native copy/download/review remain receipt-bound. Ordinary chat answers remain chat answers. Follow-up execution links to the exact result message, preserving the previous run.

### 4. Supply the context an agent actually needs

The current host forwards replyToId but not the referenced body. Include at most one directly referenced public message per selected input through the authenticated message API. Record message ID, author, revision and channel; treat it as quoted context, not authorization or an additional person's instruction. Do not crawl ambient history, DMs or arbitrary work IDs. Bound quoted text and mark truncation explicitly.

If an authorized reference is withdrawn or inaccessible, state its absence without leaking content. Transient network failures must remain retryable rather than silently converting a missing response into missing context. Include the selected reference in the existing input digest so edits/deletions during execution are reconciled before publishing. Reuse saved input/attempt handling so an uncertain response does not duplicate work.

### 5. Verify the joined experience

Extend existing tests rather than create another overlapping test framework. The browser scenario uses two authenticated participants, the real room server and a scripted agent: ask, contribute, progress, answer, reply, same-thread follow-up, return/reload, retained draft. Assert one current progress surface, exact reply target, old-run immutability and no duplicate submission. Inspect phone/desktop screenshots in both themes and keyboard behavior.

Host checks verify quoted reference provenance, bounded context, no private/cross-channel content, deleted reference handling, edited-reference reconciliation and idempotent retry. Existing native result tests retain exact bytes, withdrawal, session fences and clipboard recovery coverage. Scripted participants do not prove human usability/productivity or live-provider behavior.

### 6. Qualification and delivery

Freeze runtime/public asset manifest after implementation. Run focused checks first; repair demonstrated failures. Run affected, lint and full unit checks before pushing. Storage/write-path changes would additionally require bench:room; this intended slice changes presentation and host input composition, not the room write/storage path. Report failures and reuse unchanged-source receipts honestly.

Update PR4260 with final scope and evidence. Coordinate stack integration, required hosted checks, merge slot and deployment owner. Only report deployed after an exact revision is actually deployed and independently inspected. Record any unresolved release gates; no scheduled follow-up.

## Completion checklist

- [x] Current source, claims and previous evidence reconciled.
- [x] Compact current progress and nonduplicated history.
- [x] Work-card next step only when useful; accountability remains visible.
- [x] Direct result reply through the existing composer.
- [x] Bounded, attributed, visibility-checked reply context for agents.
- [x] Two-person/agent continuation and failure/recovery checks.
- [x] Phone/desktop visual inspection and keyboard checks.
- [ ] Final qualification and source publication.
- [ ] Coordinated integration/deployment, or precise outstanding gates recorded.


## Implementation evidence

Current progress now shows the latest recorded summary without extra messages. Work history no longer duplicates its row status and answer preview. Working/completed task cards show accountability without repeating a redundant next-step sentence. Required review and blocker instructions remain.

Reply beside a completed answer targets that exact message and uses the existing composer. An ordinary reply from someone without steering permission stays chat; explicit agent requests still receive the server permission decision. The shared host quotes the authorized direct reference with author/revision and an 8,000-code-point cap, checks it again before publication and coalesces repeated message reads within each observation. Edits trigger continuation; inaccessible/private/deleted/cross-channel references expose no text. No schema or room-write-path changes.

The initial browser pass found two obsolete duplicate-result assertions and a real permission mismatch in the second participant fixture. Corrected the assertions and explicitly granted that participant steering authority for the revision scenario. The three corrected journeys pass. Subsequent screenshot inspection found inline status laid out in the avatar grid column; fixed column placement and compact checkbox alignment. Replayed the complete two-person flow after that fix: passed. Existing 47 remaining browser checks passed, including result text/withdrawal/focus/retry and quiet layout. Agent/routing checks42/42; composed released4245 account recovery checks7/7. Lint passes with290 existing warnings. Full frozen-source qualification follows; these are not production or real-human claims.

Released carrier4245 account-creation error recovery and typed invitation name preservation are selectively composed from55532407, with both test files retained. The obsolete Ask Room mode and email workspace are not restored. Other independent storage/onboarding carriers retain their own owners and source history.

Frozen-source qualification at bc5433b9: full unit suite 11,384 passed, 31 skipped, zero failures (482.4 seconds); affected suite 2,203 passed, one skipped; lint passed with 290 warnings. Final complete browser replay passed after screenshot/layout corrections. These receipts cover unchanged runtime source; subsequent documentation and canonical screenshot updates do not represent new runtime qualification. Hosted exact-head checks and coordinated production deployment remain outstanding. Live MERGE-SLOT and ROLE-DEPLOYER were both unclaimed at the prepublication check; neither is held by this source lane.

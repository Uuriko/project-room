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
- [x] Local qualification and source publication; hosted qualification pending.
- [x] Outstanding integration/deployment gates recorded below.


## Implementation evidence

Current progress now shows the latest recorded summary without extra messages. Work history no longer duplicates its row status and answer preview. Working/completed task cards show accountability without repeating a redundant next-step sentence. Required review and blocker instructions remain.

Reply beside a completed answer targets that exact message and uses the existing composer. An ordinary reply from someone without steering permission stays chat; explicit agent requests still receive the server permission decision. The shared host quotes the authorized direct reference with author/revision and an 8,000-code-point cap, checks it again before publication and coalesces repeated message reads within each observation. Edits trigger continuation; inaccessible/private/deleted/cross-channel references expose no text. No schema or room-write-path changes.

The initial browser pass found two obsolete duplicate-result assertions and a real permission mismatch in the second participant fixture. Corrected the assertions and explicitly granted that participant steering authority for the revision scenario. The three corrected journeys pass. Subsequent screenshot inspection found inline status laid out in the avatar grid column; fixed column placement and compact checkbox alignment. Replayed the complete two-person flow after that fix: passed. Existing 47 remaining browser checks passed, including result text/withdrawal/focus/retry and quiet layout. Agent/routing checks42/42; composed released4245 account recovery checks7/7. Lint passes with290 existing warnings. Full frozen-source qualification follows; these are not production or real-human claims.

Released carrier4245 account-creation error recovery and typed invitation name preservation are selectively composed from55532407, with both test files retained. The obsolete Ask Room mode and email workspace are not restored. Other independent storage/onboarding carriers retain their own owners and source history.

Frozen-source qualification at bc5433b9: full unit suite 11,384 passed, 31 skipped, zero failures (482.4 seconds); affected suite 2,203 passed, one skipped; lint passed with 290 warnings. Final complete browser replay passed after screenshot/layout corrections. These receipts cover unchanged runtime source; subsequent documentation and canonical screenshot updates do not represent new runtime qualification. Hosted exact-head checks and coordinated production deployment remain outstanding. Live MERGE-SLOT and ROLE-DEPLOYER were both unclaimed at the prepublication check; neither is held by this source lane.

Published PR4260 targets main and preserves 4243/4244 ancestry. Hosted qualification must pass on the final head before merge; capture run39307447185 is queued to generate Linux-canonical visual baselines for inspection. If those PNGs change, commit the reviewed captures and qualify the final head. Production remains unchanged. Remaining delivery steps: inspect hosted failures, complete visual baseline update, acquire/read back MERGE-SLOT for integration, and coordinate ROLE-DEPLOYER plus postdeployment checks. No background automation was created. Real-human, physical-device, live-provider and notarized Mac distribution limitations remain explicitly deferred.

## Follow-through plan after peer synchronization

The selected Conversation and Focused task concepts are complementary: conversation remains home, and opening work/result details is a reversible focus change. Do not add another workspace or reinstate Inbox. The next pass concentrates on the boundaries between these views, not a new feature list.

1. Ask active peers for integration conflicts and independent review of authority/context boundaries. Reconcile released carriers individually; do not blindly combine whole branches or restore retired Ask/email interfaces.
2. Audit every result-to-composer transition before visual polish. Check current and destination drafts, uncertain sends, private recipients, archived/deleted sources and focus. A refused handoff must leave the result visible and explain the recovery, rather than close the reader or mutate the selected audience.
3. Fix the demonstrated handoff issue using the existing draft store and a boolean success contract between the reader and app controller. Resolve the destination before navigation; preserve source and destination drafts. Keep the reader responsible only for display and the app responsible for composer state. Add a browser regression that reproduces refusal and verifies result text, draft and audience survive, then verifies successful reply after recovery.
4. Inspect the Linux-canonical baseline artifact against the old screenshots, including unintended loss of meaningful controls. Adopt only reviewed intended changes; do not loosen screenshot thresholds. Keep phone/desktop and light/dark evidence from the functional journey.
5. Evaluate peer findings by severity and evidence. Fix concrete loss, leakage, wrong attribution, authority or retry errors before cosmetic additions. Record deferred improvements with their rationale rather than silently growing v1 scope.
6. Refresh generated assets only after source settles. Run the changed journey and agent tests first, then repository publication checks. Reuse previous unchanged-source results explicitly; report any new failures. Publish the coherent branch, reconcile exact-head CI, and retain separate merge/deployment coordination.

Exit criteria: no silent failed result handoff; no draft/audience loss; direct reply still starts the intended authorized continuation; canonical screenshots reviewed; peer findings dispositioned; exact evidence and remaining delivery gates recorded. This does not establish real-human usability or promise a bug-free product.

### Peer review and implementation checkpoint

The existing implementation peer reviewed9d253c8c read-only. It confirmed the selectively composed account fixes and found no new blocker in the selected routing/context path. Its merge-tree checks show4246 and4267 compose cleanly separately; this does not qualify their combined runtime. Keep those carriers independent until their source and purpose are reviewed. Three delivery requirements remain: update/identify the existing shared Codex host as well as the web deployment; retain denied-permission and draft-preservation coverage; distinguish edited-reference publication freshness from external-effect safety. The runtime already instructs reconciliation before repeating effects, but the quoted-reference test is not evidence of arbitrary external exactly-once behavior. Do not claim it is.

Implemented a reproduced result-reader handoff defect. Before the fix, the new browser scenario failed because Discuss result dismissed the reader while a private destination draft prevented reply. The controller now checks the destination before navigation; refused handoff retains the exact reader/current draft and explains recovery. The reader closes only after controller success. The regression confirms the private draft and audience survive, and normal reply/focus works after recovery. Targeted regression plus existing desktop/mobile result scenarios pass3/3.

Reviewed Linux-canonical capture39307447185 (successful) and adopted its four changed PNGs; join-consent is byte-identical. Login and room captures have current runner font metrics/wrapping, with controls retained and no added overflow; join-error retains recovery links. Magenta masks hide dynamic fixture fields, not product elements. No screenshot threshold was changed. These capture the pre-handoff-fix runtime; that fix does not alter the captured initial screens.

Broader follow-up qualification is NOT green: the concurrent full, affected, lint and native-result browser runs suffered severe local contention (load268; one cold-start wall818s vs CPU112ms). Stopped only this lane's process trees to release resources; retained logs at /tmp/chat-result-polish-{full,affected,lint,browser}.log. Full and browser had failures/timeouts before interruption, not successful receipts. The earlier11,384-pass result applies tobc5433b9, not this subsequent handoff fix. Resume bounded/sequential qualification after resource recovery, then publish. Do not widen timeouts or rerun merely to hide the failed result. Source remains local until the required publication checks are assessed.

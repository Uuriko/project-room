# Cohesive collaboration delivery plan

## Outcome and current truth

Keep Apache-2.0. Make conversation -> exact result -> feedback -> continuation -> revised result -> return one coherent experience for people and external agents. No Inbox, email workspace, marketplace, workflow-builder or license change.

Baseline: origin/main 8a895d36 includes PR4260 and the prior conversation release. Existing result reader, version comparison, reply routing, portable work and return brief must be reused. Prior qualification is baseline evidence, not proof of this candidate. Public notarization, real-human productivity and physical-device/provider qualification retain their previously stated limitations.

## Work sequence

### A. Establish component ownership (execute first)

1. Keep a separate current-main checkout and preserve peer focus-rescue PR4285.
2. Extract version comparison from app.js into a controller owning its pending reads, display lifetime and withdrawal handling. Inject client/state/escaping; no access to global app state. Reuse the same controller in review and reading.
3. Extract feedback routing into a controller with explicit conversation/composer dependencies. Resolve and validate destination before navigation. Preserve unrelated drafts and refuse private/pending drafts. No mutation on invalid or stale results.
4. Register modules in both deployed assets and cold runtime packages. Regenerate candidate pins, verify imports and focused browser journeys.
5. Add narrow regression tests for stale completion, withdrawal, reply eligibility and draft preservation; avoid testing only source layout.

Acceptance: the application composes these controllers; implementations own their lifetimes and no longer live in app.js. Existing desktop/phone result review and continuation tests remain green. Refactoring does not change backend schema or write semantics.

### B. Simplify the human flow

Audit the existing flow in a real browser before adding controls. Keep one composer and contextual result reading. Remove duplicate actions only after identifying the replacement. Preserve draft text, attachments, focus and room/thread selection. Check 390px and desktop, large text, keyboard, pending/error states. Result feedback remains attached to exact result context. Changes must improve an observed interaction; do not perform a speculative CSS or framework rewrite.

### C. Complete the shared continuation contract

Trace human reply and external-agent context through existing work/run APIs. Confirm exact source version, authorized inputs, interruption/resume state and new result identity. Fix actual gaps. Human and agent actions share backend permission and state rules. No new parallel task system. Do not claim a configured live assistant based on synthetic fixtures.

### D. Interruption and return

Exercise room switch, restart, stale reads, withdrawn result, lost connection and concurrent revision. Preserve the right draft and provide an actionable recovery state. Reuse return-brief/context APIs; no new Inbox. Scope caches and context to current authority and version.

### E. Integration and release

Run affected tests and lint, then full required unit/hosted checks on the frozen candidate. Run bench:room once if storage/write/sync/replay changes enter scope; report inconclusive/regressed outcomes honestly. Reconcile native claims before landing. Acquire/read back merge and deployment ownership, preserve peer ancestry, deploy only qualified source and independently verify both doors and public assets. Do not create a recurring automation.

## Architecture direction

Keep a modular application. Ownership boundaries: identity/access, conversation, work, artifacts, execution, context, application shell. Direct commands validate requested changes; durable events describe committed facts. Separate services only for demonstrated isolation/scaling needs. Selective client caching/offline resilience is preferable to an unproven wholesale local-first rewrite.

## Decision and deletion discipline

For every addition record the user outcome, agent operation, state owner, authorization/failure behavior and replaced path. Remove replaced code once callers migrate. Reject extra abstractions that merely rename existing coupling. Keep a single delivery checklist with evidence, rather than producing competing roadmaps.

## Progress and limits

- [x] Reconciled origin/main and current open PRs; prior flow is shipped.
- [x] Created isolated current-main branch.
- [x] Recovered the existing saved john-codex identity and acquired/read back codex-collaboration-components-1019 after a fresh live census. Peer onboarding/CI lanes remain separate.
- [ ] A: component extraction and regression qualification.
- [ ] B: observed UX cleanup.
- [ ] C: shared continuation gaps resolved or explicitly shown covered.
- [ ] D: interruption/return qualification.
- [ ] E: hosted qualification, integration, deployment and independent verification.

## Implementation checkpoint

- `src/result-comparison.js` now owns comparison reads, invalidation and rendering for both result reading and review. Session/view ownership remains explicit through the injected lifetime predicate.
- `src/result-feedback.js` owns eligibility and destination validation. The shell retains navigation, composer state and focus. Missing destination drafts are safe; private/pending drafts prevent navigation.
- Missing previous-result responses now show comparison-unavailable feedback; they no longer silently hide the comparison. Mismatched completion IDs cannot render unrelated prior text.
- Result reading collapses its expanded work-details entry surface and restores it when closing, including keyboard focus. Replying still enters the existing conversation without reopening those controls.
- Both server allowlist and cold runtime package include the extracted modules. Comparison summary is catalog-backed with no i18n ratchet waiver.

### Scope reconciliation

Existing backend selected-work context already includes versioned current records, scoped reply pointers, resume state and explicit omissions. Existing browser journeys exercise human assignment -> MCP participant result -> continuation -> restart. Preserve those semantics; no replacement execution framework or backend schema change is warranted by this slice.

The phone screenshot audit found competing secondary controls above the reader; the details-collapse change addresses that observation. The persistent attention region and longer independent-review form remain candidates for a subsequent focused design slice, not silently declared redesigned here.

### Evidence ledger

- Initial browser suite: 40/40 passed. Final details-collapse browser run pending at checkpoint.
- Component unit regression suite: 10/10 passed, including late response replacement, withdrawal, escaping, missing/mismatched previous result and protected drafts.
- Initial affected run: 1327 passed, 1 skipped, 1 failed (i18n ratchet). Catalog extraction and machine error code repair resolved it; focused E4 baseline rerun passed. Preserve original failure log.
- Lint: zero errors; 290 existing warnings. i18n final check passes without allowance/baseline change.
- Packaging regressions and full unit run pending; local Node26 differs from Node24 hosted qualification.
- No storage/write/snapshot/sync/replay change; bench:room not applicable to this UI/controller slice.
- Browser participants are scripted. No real-human productivity or live-provider execution claim.
- Not merged, deployed or independently production-verified.

## Subtraction audit (John's explicit steering)

Hiding controls is insufficient. Keep only distinct user outcomes, not one button per internal operation.

| Existing choice | Decision | Reason |
| --- | --- | --- |
| Standalone Paste AI draft on every work card | Remove | Duplicates the return step already inside Use my AI; retains the existing import path and private draft recovery without another card option. |
| Duplicate DONE badge beside Completed on work cards | Remove | States the same completion twice; retain the canonical work status and separate review status. |
| Changed-byte count in human revision summary | Remove | Reviewers need meaningful edits; machine byte accounting adds text without helping judge the result. Line differences and exact text remain. |
| View result / Reply | Keep | Reading an artifact and responding to it are the central collaboration flow. |
| Share draft | Keep provisionally | Creates a version-linked proposal with stale-basis handling, unlike an ordinary chat message. A future composer integration can replace the separate editor only if it preserves these semantics. |
| Copy summary vs Copy exact text | Keep distinct for now | Summary sharing is redacted and audience-aware; exact copy is explicit. Do not silently substitute one for the other. |
| Use my AI | Keep | Enables participation without installing or authorizing a provider; remove the duplicate return entry, not this interoperability. |
| Use again | Keep secondary pending usage evidence | Starts separate work with reused definition; it must not masquerade as continuing the same work. |
| Access preview | Keep secondary | Lets a person inspect what an agent will receive before giving it work. It is not authorization. |
| Repeated future controls | Admission rule | Name the existing path it replaces or the unmet user outcome it serves; otherwise do not add it. |

Follow-through: update existing external-AI browser journeys to use the single entry. Preserve unsent returns and focus restoration. No new settings or toolbar replace deleted controls.

## YC research applied during implementation

Sources consulted October 19, 2026; these are enduring founder/design lessons, not claims of new 2026 research.

- Dominika Blackappl, [Practical Design: MVP Spec](https://www.ycombinator.com/blog/practical-design-mvp) (2016): a viable product tells a complete story; its leading function should determine the feature set. Application: preserve the full external-AI round trip but remove its duplicate card entry. Avoid equating more agent tools with more user value.
- Adora Cheung, [Building Product, Talking to Users, and Growing](https://www.ycombinator.com/library/dS-how-to-start-a-startup-building-product-talking-to-users-and-growing): warns against assembling every requested feature and emphasizes a clear functional benefit. Application: this plan is a selection, not a promise to implement every prior brainstorm. Existing controls must justify themselves too.
- Joe Gebbia/Reid Hoffman, [Scaling Product at Airbnb](https://www.ycombinator.com/blog/scaling-product-airbnb/) (2017): design the whole experience and observe customers in context. Application: cover arrival, conversation, result, feedback, interruption and return together; inspect actual phone screenshots rather than optimizing isolated components.

Product hypothesis: a small team can finish and continue useful work with its agents without reconstructing context. The leading measure is successful useful collaboration, not button count or messages sent. Fewer buttons can still be worse if the remaining path obscures an important action; preserve the external-AI return and private drafts while testing the consolidated route.

Research does not establish demand or human preference. Synthetic journeys validate mechanics; future real-team sessions should examine a recent actual task, existing workaround, friction, and whether people choose to return.

### Latest focused qualification

- External-AI consolidation: 12/12 browser checks pass (desktop/phone export, return, private drafts, clipboard fallback and stale-return handling).
- Reading/details collapse initially failed two assertions because the opener is outside the details element. Fixed by targeting the owning card's details. Corrected desktop/phone focus plus revision journeys: 4/4 pass.
- Cold packaging/controller checks: 27/27 pass before the subsequent presentation-only edits.
- Full local unit run and final affected/lint verification remain running; do not call this a release receipt.

### Publication qualification limits

Final affected run found the newly tracked controller modules missing from the i18n scan inventory. Added only those two paths to i18n-scope.json; no baseline counts changed. Focused E4 rerun and preflight pass. Full ESLint reported zero errors (290 warnings); final changed-file lint and remaining checks are being reconciled.

The broad Node26 full run reported an OG PNG golden-hash mismatch and a public-read latency threshold failure under concurrent load. The same OG test fails in the untouched previous checkout on this runtime. These are retained failures, not waived checks or proof of a production regression. Full run remains incomplete; hosted Node24 qualification is required before landing. Do not call the broad test run exact frozen-head evidence: this turn's user-directed subtraction edits occurred during it.

The final badge deletion initially removed a still-used import for message rendering. Changed-file lint caught it and the browser boot failed; restored the import while retaining removal of the duplicate work-card badge. Final targeted recheck required before declaring the deletion qualified.

Final badge/import correction: desktop and phone inline-result checks 2/2 pass; changed-file ESLint zero errors, 2 existing browser-fixture warnings. Retain the earlier failed run as superseded only for this explicitly rechecked path. Candidate remains draft pending hosted qualification and broader-suite reconciliation.


### Follow-up bug audit (2026-10-19, PR4288)

Hosted Node24 unit, lint, coverage, Cloudflare, eval and invariant checks passed at 9e811941. Contract failed because this document was missing from INDEX. Browser shards 2 and 4 retained the removed standalone external-AI return entry. Repaired both fixtures to enter Use my AI then Paste AI draft; all 23 draft-return/native-draft browser checks pass locally. Docs reachability passes (602 links). Changed-script ESLint has zero errors and one existing prefer-const warning. These are local repairs; no new hosted-head or deployment claim.

New product findings, not fixed in this checkpoint:

1. Result reader copy timeout releases its per-view copy flag after 1500ms, although the OS write is not cancellable. A deterministic real-browser experiment held that write, waited for the failure message and enabled button, issued a newer copy, then completed the old write. The old content overwrote the newer clipboard content. Evidence: /tmp/room-clipboard-audit.mjs and /tmp/room-clipboard-audit.log. This uses a simulated clipboard implementation, not evidence of OS incidence.
2. Portable prompt and editable-result copy paths instead retain pending-write latches indefinitely. Code inspection and existing held-copy tests show reopening preserves those latches: a never-settling clipboard operation keeps copy/context controls or editable-result input disabled. No bounded recovery is implemented there.
3. Each surface owns a separate clipboard latch, so those latches do not serialize writes across the result reader, prompt dialog and editable-result dialog. This is a code-level finding; cross-surface overwrite remains to be reproduced independently.

Next build: one shared clipboard-operation owner for these surfaces, with retained in-flight ownership, explicit pending versus failed outcomes, stale-view fencing, and usable selection/download fallbacks. A timer must not pretend to cancel the OS write. Test actual out-of-order settlements and view/session transitions. Avoid adding permanent controls or claiming clipboard writes outside this app can be controlled. Then finish exact-head CI and coordinated landing of PR4288.


## Next execution slice: connected focused work

Outcome: chat remains home; opening work exposes its source conversation and useful result, and resuming carries recorded progress without re-entering it. No new task model, queue, dashboard or persistent toolbar.

1. Move the existing source-conversation link from the Details disclosure into the card's primary content. Preserve its route, focus key, permission checks and draft-safe navigation; do not duplicate the link. Keep the distinct private/audience-aware summary and exact result semantics.
2. Wire the existing data-portable-progress intent into prompt creation. Continue with saved context selects progress; ordinary Use my AI remains minimal. The checkbox stays inspectable and removable. Do not include source messages implicitly or issue commands by opening/copying.
3. Introduce a small shared clipboard controller. It owns one outstanding OS write across the result reader, AI prompt, and editable summary. No queued writes (a queued action could outlive authorization). After 1500ms return a pending outcome while retaining the lock until actual settlement. Do not claim cancellation. View controllers own status and session eligibility. Allow editing and context inspection after the pending threshold; keep further programmatic copies disabled until settlement. Downloads and closing remain available. This coordinates these application surfaces, not other applications or tabs.
4. Replace each surface's direct clipboard write with this controller. Catalog pending-state copy, preserve real failures and normal success, and never report a retired operation on a replacement view. Opening a view during a pending operation should explain why copying is unavailable.
5. Unit-test contention, sync rejection, delayed completion after timeout, recovery and subscriber state. Browser-test cross-surface contention, pending edit recovery, exact prompt inclusion, no unintended source context, draft-safe navigation, desktop/phone and light/dark rendering. Capture and inspect screenshots.
6. Register the shared module in public assets and cold packaging; coordinate runtime-package ownership with Grok. Update generated strings/manifest without changing ratchet allowances. Run focused tests, affected tests, lint and full unit suite before pushing. Reuse unchanged evidence only where applicable and retain failures.
7. Update PR4288 with exact scope and evidence, including a large-diff rationale for coupled controller extraction and its integration tests. Keep unqualified work draft. Merge/deploy remain coordinated separate operations after hosted checks; this plan does not claim production completion.

Completion criteria: source conversation reachable without opening Details; resume packet carries recorded progress and excludes unselected source; one programmatic write at a time across all three collaboration copy surfaces; no false timeout failure; pending operation does not freeze editing; real late completion cannot change another view's status; relevant browser journeys pass with no room writes from export/navigation.


## Detailed design before further implementation

This section supersedes the shorter next-slice outline above. John requested a complete, revisable design before more source changes. Implementation is paused while this plan is developed. Existing local changes are prototypes to evaluate against this design, not evidence the whole plan is finished.

### 1. Scope and product outcome

Deliver one connected flow: enter a room, discuss a real request, make the request actionable, see who is working, inspect a draft/result, respond in its conversation, revise, and return later without reconstructing context. Human and agent interfaces use the same work identities, versions and permissions. We will not build new inboxes, dashboards, marketplaces, task systems, or orchestration frameworks for this slice.

The central design constraint is that ordinary conversation is sufficient for participation. Structured work supports execution, accountability and review; it must not require people to manage agent machinery. We infer suggested intent from chat but do not silently turn an ambiguous message into authorized execution, choose a private audience, or invent acceptance criteria. Use context already available; ask one targeted question only when a missing fact affects the result, audience or authority.

Scope layers: (a) finish the existing collaboration PR and its proven bugs, (b) simplify focused work navigation and state presentation, (c) close demonstrated human/agent continuity gaps. Room entry and agent onboarding receive integration checks here, while their existing owners retain implementation ownership. This is not a promise to rebuild every adjacent feature.

### 2. Current implementation and constraints

Existing: room conversation, source-linked work items, per-conversation drafts, versioned drafts/results, exact result reader, review and feedback routes, selected-work agent context, portable AI prompts/returns, interruptions and resumptions. PR4288 extracts comparison/feedback controllers and removes duplicate actions/status text. Local e68c4d0f repairs obsolete browser entry paths and docs reachability.

Started locally but not committed/published in the new slice: shared clipboard prototype, source-link relocation, saved-progress wiring, regression checks and asset registration. These have focused tests, not full qualification. New src/clipboard.js still needs cold-runtime registration; scripts/runtime-package.mjs is held by Grok and a handoff has been requested. Do not publish an incompletely packaged module.

Observed navigation mismatch: revealWork currently opens Details automatically. Moving important actions outside Details is insufficient if ordinary navigation expands the machinery again. The focused-view work must separate ordinary work navigation from explicit evidence/details navigation.

### 3. Human journey and layout

Room entry: preserve the invited room and intended destination through authentication. Return to that destination after success. Explain invalid/revoked access in place. Do not display internal identity material. Reuse current entry implementation and coordinate onboarding defects with its owner.

Room conversation: primary space for messages, drafts and replies. One composer. A compact work reference connects a request to execution. Avoid duplicating a full status report both in chat and on the card. Routine machine events remain out of the conversational foreground unless they change what a person must do.

Focused work, desktop: reuse the current in-conversation card/reader rather than add a competing permanent column. Order is title and current state; accountable person or active worker where useful; source conversation link; actual next step/blocker; latest useful result or draft; contextual primary action. Details follows secondary to these. Reserve space based on content, not a fixed empty panel. Use existing type, spacing, target-size and color tokens.

Focused work, phone: same information order in one column. No side-by-side editor/review pane. Long text wraps. Buttons fit narrow width and retain usable touch targets. Opening a result focuses its heading; closing returns to the originating control. Keyboard and browser-back navigation preserve context and drafts.

Details contains acceptance criteria, recorded evidence, history, execution scope and advanced actions. Ordinary work navigation leaves it collapsed. An explicit evidence/details destination opens only the needed section. Do not nest multiple similar menus or use Details as a dumping ground for unrelated functionality.

Source conversation: one visible link outside Details; remove the duplicate handoff link. Follow the existing draft-safe navigation route. If the source is unavailable, say so rather than jump to unrelated conversation or an empty view. Do not infer thread from whichever thread happens to be active.

Result: exact submitted text, author, and one clear current-state indication. Earlier and withdrawn versions remain distinguishable. Reply uses the existing conversation composer; it does not create another comments system. Review/approval remains a separate operation when required. Summary export and exact-text export remain distinct because their content/audience guarantees differ; they must not both masquerade as the same Copy action.

### 4. State and action design

Before rendering changes, write an explicit table for proposed, accepted, running, interrupted, draft available, awaiting review, changes requested, completed and withdrawn/unavailable result. For each, derive: displayed label; responsible actor; next useful action for this viewer; secondary actions; source/result availability; recovery path. Derive this from existing selectors and permissions, not a second workflow model.

Proposed: show the request and any genuine missing decision. Running: show who is working and meaningful progress; avoid fake progress percentages. Interrupted: show recorded progress, why it stopped when known, and a continuation path that does not imply the old process is terminated. Draft available: read/discuss; do not label it complete. Awaiting review: show a review action only to eligible reviewers. Changes requested: connect feedback to its exact result and route continuation to the same work. Completed: lead with the usable result. Withdrawn/unavailable: explain what can no longer be read; never reuse cached private text as fallback.

Use one primary next action when the state and viewer make that choice clear. Do not hide two genuinely different required decisions behind an arbitrary primary-action rule. Unavailable actions should normally be absent; temporary pending actions may be disabled with contextual status. Controls with no executable outcome are removed.

### 5. Human-agent and agent-agent contract

A human supplies objectives and feedback in conversation. An agent gets scoped context sufficient for the next action: work ID, revision, source pointers, current result/version, relevant feedback, accountable actor, allowed actions, recorded progress and omissions. Existing server authorization is authoritative; a frontend preview grants nothing.

A continuation preserves the work identity unless the person explicitly starts separate work. A revised result receives its own exact identity/version. Prior approval does not carry over. Replies point to the intended result/message. Duplicate delivery retries preserve request identity; uncertain writes do not produce replacement commands or duplicate contributions.

Inspect existing selected-work, progress, result and return APIs before adding fields or endpoints. Patch a demonstrated missing link in its owning module. Do not introduce a new context protocol simply to rename existing data. Agents should discover the current schema and valid next actions without scraping UI or downloading the whole room.

Human-human, human-agent and agent-agent paths must agree on authorship, audience, ownership and completion. Synthetic mixed-role tests validate these mechanics; they do not establish real-human preference, live-provider reliability or productivity gains.

### 6. Component boundaries

Application shell: composition, current identity/room, history/navigation and top-level controller wiring. It should not gain more domain state machines.

Conversation/composer: draft scope, audience, reply target, attachments and uncertain send identity. Work navigation calls this owner rather than manually changing draft fields.

Work presentation: a pure derived view model using current workflow selectors, with a small renderer. Extract only the state/action mapping and rendering that this change actually needs; do not move thousands of lines wholesale. Permission checks remain server-enforced.

Result reader: pinned version, loading/unavailable/withdrawn state, focus and reading lifetime. Result comparison: two exact versions and invalidation. Feedback controller: eligible target resolution before navigation. Portable work: explicit context selection, external prompt and attributable returned draft. Shared clipboard: only OS-write lifetime and contention; no room state, credentials or text persistence.

Each asynchronous operation captures the relevant session generation, room, identity, work/version and owning view. A response applies only while those still match. Avoid a generic global controller framework. Shared abstractions must eliminate actual duplicated invariants, not merely shorten code.

### 7. Clipboard behavior and limitations

Use one shared owner across result reader, AI prompt export and editable summary. Start clipboard writes synchronously within the user interaction. Reject concurrent attempts; never queue them behind an operation whose context may be stale. Normal fulfillment reports copied only to its still-owning view. Real rejection gives a manual fallback without losing text.

After 1500ms without settlement, show pending, not failure. The threshold affects feedback, not correctness or a performance claim. Retain the shared lock until real settlement. Release local editor/context controls after the threshold; a delayed clipboard request must not freeze unrelated work. Keep closing and result downloads available. Show why copying is unavailable when another surface opens during an outstanding operation.

After late settlement, release the lock, clear obsolete pending notices, and do not claim newer edited text was copied. A closed or replaced view receives no success/error updates. No browser API reliably cancels an issued write: do not pretend otherwise. This module cannot serialize other tabs/apps or revoke text already handed to the OS. Avoid automatically copying again, automatically changing the user's clipboard, or persisting copied content.

Audit all collaboration callers for local guards conflicting with the shared owner. A controller subscription updates controls; it must not steal focus from another dialog. Keep event listeners/subscriptions bounded to controller lifetime.

### 8. Resume/export behavior

Continue with saved context means the prompt includes recorded progress and handoff. Honor the existing data-portable-progress intent before generating preview. Ordinary Use my AI remains minimal by default. Source-message inclusion is independently opt-in; do not assume progress consent is permission to add source/private conversation.

Preview shows exactly what will be copied and allows removing optional context. Opening, inspecting, copying and downloading do not mutate work. The prompt identifies the current work/revision and preserves the return contract. It does not authorize external changes or restart a process. Returned text becomes a draft with attributable provenance; completion remains the existing explicit workflow.

An unsent return survives dialog navigation according to existing draft policy. Native drafts and external returns remain separate. Stale-basis submission requires explicit correction/acknowledgment through the existing path; retry of an uncertain save sends the same command.

### 9. Navigation, recovery and accessibility

Source to task to result to reply to back must preserve each scoped draft, audience and attachment state. Do not silently overwrite an authored private or pending destination draft. Focus restoration must target an existing visible control and not reopen unrelated panels. Session changes clear protected content and invalidate old callbacks.

Reconnect preserves the exact uncertain operation until confirmed or deliberately corrected. Avoid describing unconfirmed work as saved. Distinguish unavailable history from empty history. Interrupted work explains recorded facts without claiming external process state is known.

Use native links/buttons and semantic headings. Verify keyboard operation, Escape, browser Back, focus after rerender, large text, light/dark themes and phone width. No fixed layout dimensions that obscure the composer or force horizontal scrolling. Do not add animation unless it conveys necessary state; respect reduced motion.

### 10. Performance and maintainability

Use current selectors and loaded state for local navigation whenever possible. Fetch older result/context only when needed; pin requests to exact versions. Avoid fetching an entire room to render one task unless the existing API truly requires it; identify that limitation before promising otherwise. Share in-flight reads only when authority and version match. Never reuse private context across identities to save a request.

Measure browser interaction latency, requests and transferred bytes for representative short/long rooms before adding caches or replacing rendering. Preserve existing incremental rendering and focus. Do not remount the entire conversation for clipboard updates. Use the shared benchmark only if write/storage/snapshot/sync/replay enters the diff. Do not claim speed gains from cleaner code alone.

No new framework, backend service, database, schema migration or dependency is currently justified. Keep APIs narrow, errors explicit, and generated registrations synchronized. Existing maintainability improvement is moving owned behavior out of app.js; the next extraction should follow demonstrated coupling in focused work presentation.

### 11. Exact implementation order

A. Finish and review this design; record existing/proposed/prototype status. Build the state/action table against actual selectors and audit navigation entry points. Check live claims and preserve peer work.

B. Finish shared clipboard controller and surface integration; review timeout ownership, stale status and listener/focus behavior. Complete unit and cross-surface browser regression. Coordinate module registration before packaging or publishing.

C. Finish resume export wiring and direct conversation link. Remove duplicate handoff link. Validate default/minimal exports, saved progress inclusion, source omission and unchanged work state. Exercise the source link with an authored draft.

D. Make ordinary work navigation leave secondary Details collapsed. Retain explicit evidence/details navigation and disclosure restoration. Use the state/action table to simplify only redundant labels/controls. Extract a work presentation module only if this change requires repeated conditionals that cannot stay in existing selectors. Capture before/after views.

E. Walk the full source request -> work -> agent draft -> result -> feedback -> revision -> return flow. Resolve demonstrated missing references, protected-draft collisions or stale-version bugs in the correct owner. Do not add parallel APIs or make draft posting imply completion. Coordinate any onboarding/server fixes with their owners.

F. Reconcile and freeze the candidate. Run focused suites, affected checks, lint and required full suite; inspect real failures rather than changing assertions to match bugs. Register assets, generated strings, scan inventory and candidate manifest. Document environmental baseline failures separately from candidate regressions.

G. Publish/update the PR with exact scope and evidence, then reconcile hosted checks. Land and deploy only through coordinated ownership with peer ancestry preserved. Independently check deployed assets, both public doors and critical flow. A successful local test is not deployment evidence.

### 12. Acceptance and exit criteria

A person can reach source conversation without opening Details; ordinary task navigation does not expand secondary machinery. State/next-action display agrees with current workflow and viewer authority. A result is readable and discussable in context without losing existing drafts. Private/pending drafts cannot be silently retargeted. Revised results do not inherit approval. Resume export includes selected progress and no unselected source. Export/navigation cause no work mutation.

Clipboard tests exercise real contention, timeout then late fulfillment/rejection, view close/reopen, cross-surface use, editing during pending, and session invalidation. Only one programmatic write from these surfaces may be outstanding. Pending does not mean failed and does not freeze editing. No stale completion claims a different draft was copied.

Phone and desktop, light and dark, keyboard/focus and narrow-width layouts are reviewed from screenshots and interactions. Browser simulations are labeled as such. Keep public notarization, physical-device qualification, real-provider behavior and real-team productivity as explicit separate qualifications.

At each checkpoint record what changed, what was removed, tests/evidence, known gaps and the next dependency. If a test or interaction contradicts this plan, amend the relevant design section and reason before expanding implementation. Do not restart the whole plan or silently add unrelated features.


### Cross-platform delivery (John clarification, October 19)

The core UI and server semantics are shared: browser web, Mac AppKit/WKWebView loading the hosted UI, and responsive mobile web/PWA. No native iOS/Android application is claimed. Every release receipt must separately identify web source/deployment, Mac shell source/build plus loaded web origin/revision, and mobile/PWA asset/service-worker state. A shared UI does not prove native integration works.

For this slice verify conversation/task/source/result navigation, draft preservation, copy contention, and downloads in the shared browser suite; compile the actual Mac shell and run native WKWebView acceptance against the same candidate source on loopback. Check touch layouts and mobile/PWA behavior separately. Do not silently replace the user's installed app or production room during synthetic checks. A standalone Mac source revision identifies the shell, not necessarily the remotely loaded UI revision. Developer ID/public notarization remains explicitly deferred; real-provider and physical-device results remain distinct from synthetic qualification.


### Implementation checkpoint: focused collaboration

Implemented shared clipboard ownership across reader, prompt and summary; pending copies retain the OS-write lock while editing remains usable. Implemented explicit saved-progress export, direct source-conversation link, collapsed ordinary task navigation, preservation of deliberately opened disclosures on Back, and visible current blocker reasons. Removed the duplicate handoff conversation link. Screenshot inspection found low-contrast handoff text in light mode; it now uses light-theme surface/text tokens and both theme tests require at least 4.5:1 contrast for the touched text.

Early qualification: 1405 affected tests pass, one skip; first navigation set 73/75 with two stale secondary-action entry tests, corrected and targeted 3/3 recheck passes. Entry surfaces 23/23 pass. Resume/context/source-draft/contrast paths 2/2 pass. Clipboard unit tests 4/4 pass. Full suite, final lint, packaging and native Mac acceptance remain in progress at this checkpoint; no deployment claim.

Packaging registration was an isolated additive edit to runtime-package.mjs after announcing the filename overlap on the bus/board. Grok retains the shared claim and its checkout is untouched. Preserve its catch-up additions during integration. Native source claims cover UI/test files; do not describe the refused overlapping packaging claim as acquired.

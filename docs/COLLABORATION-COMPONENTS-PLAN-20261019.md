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

### Cross-platform execution receipt — 2026-10-19

The development Mac app built successfully from UI revision `2e0f3443715f3251ffb4ed7a1c778862e7ab99d9`. Actual isolated WKWebView acceptance against that candidate on localhost passed account creation, direct personal-room entry, message receipt, profile editing without leaving the conversation, durable draft storage, and close/reopen recovery. Updated both native acceptance scripts to the current Profile dialog; their obsolete Inbox navigation was a test drift defect after the intentional Inbox removal. Native attachment and HTML export checks both completed actual downloads and close/reopen recovery. Screenshot: `/tmp/room-focused-native-first-use.png`. Logs: `/tmp/room-focused-native-acceptance-fixed.log` and `/tmp/room-focused-native-downloads.log`.

Desktop/phone browser checks and PWA checks remain separate evidence from native WebKit. Mobile is responsive web/PWA, not a native iOS/Android application. Physical-device, real-human, real-provider, and public notarized Mac distribution qualifications remain outstanding or explicitly deferred; the development build does not satisfy them. Nothing was installed over the user's app or deployed.

The broad local suite completed with 11,400 passes, 31 skips, and two failures. Its i18n scope-growth check passed separately after committing the changed scope manifest; the other failure is the previously reproduced Node 26 OG PNG golden-byte mismatch. This broad run overlapped source edits and is supporting evidence, not an exact-head release qualification. No golden values or allowances were weakened.

## Existing-product QA audit — 2026-10-19

Scope: frozen source candidate `6b7fe857`, not deployed production. Feature expansion paused for the owner's requested design and reliability review. Reviewed DESIGN.md and the room-antislop checklist, exercised the local app interactively, ran existing browser journeys, inspected fresh screenshots, and reviewed the clipboard/comparison ownership code. This is simulated use and automated QA, not independent human usability evidence.

### Findings and repair order

1. **High, functional: self-hosted agent onboarding points to another host.** On localhost `/docs/agents/paste`, all pasted enrollment blocks direct the agent to `https://room.trydemigod.com/llms.txt`; manual enrollment and MCP commands also name production. Source: `docs/agents/paste.md:23` and subsequent blocks; `scripts/build-agent-docs.mjs:175` renders these unchanged. The page is linked by the local Agent sign in route. An agent following the manual steps can attempt enrollment on the wrong deployment. No such outbound enrollment was performed in this audit. Repair before expanding onboarding: derive the destination from the explicit invite origin, preserve its fragment exactly, and make all discovery, enrollment and MCP calls use that same validated origin. Test two distinct server origins and ensure neither credentials nor invitation tokens go to the other server. Do not blindly substitute an untrusted forwarded Host header.
2. **Medium, layout: approval content hierarchy is inverted on a phone.** Fresh `test-results/crowded-reconnect-collaboration-touch-decision.png` shows revision/stored-text metadata, check criteria, two disclosures and provenance before the actual result; decision and reason fields push the final controls below the initial viewport. Scrolling/focus checks pass, so this is not a claim of inaccessible controls. Source: `src/app.js:6312` and `:6348`. Lead with the result and required decision, place extended provenance under existing secondary disclosure, and preserve authorship/verification distinctions and approval authority.
3. **Medium, layout: attention controls compete with the focused result.** Fresh `test-results/room-results-20260908/inline-result-phone-light.png` shows Updates, Catch up with a count, a Needs your attention card, Refresh and Review above the opened result. Each may function, but the combined hierarchy takes substantial space from reading. Consolidate navigation to the same attention state; do not create another dashboard or remove distinct actionable obligations.
4. **Medium, onboarding: invite instructions overwhelm the primary field.** Interactive `/join` at the narrow viewport renders a long explanatory paragraph before the invite input, followed immediately by a separate request-access form. Source: `join.html:30` and `:40`. Reduce the instruction to code-or-link plus preview-before-join; disclose request access only when needed. Invalid-code submission correctly retained the input, focused it and explained how to recover.
5. **Medium, agent/human handoff: simple paste route has high manual effort.** The link promises one block, but the destination is six lengthy runtime blocks plus manual setup, with no visible Copy control. The static no-script page is intentional in `tests/connect-paste-page.test.js`; adding a button requires an explicit accessible enhancement and CSP design, not a dead decorative control. Prefer one common connection block with optional runtime details, keeping a no-script selection fallback. This is a design finding, not a failed endpoint.

### Evidence and limits

`/tmp/room-current-qa.log`: 16/16 passed at the frozen candidate. Covers serious/critical axe checks on login/composer/room, narrow slow-loading dialog focus in both themes, entry recovery/search, phone message menus, stable simultaneous human/agent choices, and clarify/restart/contribute/review in ordinary and crowded rooms on desktop and touch. Synthetic MCP producer/reviewer participants were exercised alongside the browser; no real model invocation.

Interactive local browser inspection covered login, invite entry, invalid-invite recovery, return navigation, Agent sign in and its paste-instructions link. Screenshots inspected included phone light Rooms, phone dark approval, and phone light inline result. Earlier actual native WKWebView signup/download/reopen receipts are retained above; not rerun because native/runtime sources did not change. Real human, physical-device, real-provider and public notarization qualifications remain separate.

Do not interpret passing functional checks as design approval. No new feature or source patch was made during this audit; the identified repairs require the narrow design above and regression evidence. The previous broad suite's PNG golden mismatch and exact-head hosted qualification remain recorded rather than silently discarded.

Second batch `/tmp/room-current-qa-core.log`: 61/61 passed, covering agent sign-in, accountless join restoration, auth return, design cohesion, portable work including lost-response retries, result copying, room-only navigation, result privacy/withdrawal, delayed comparisons and focus recovery. Combined audit: 77 passes, zero failures, zero skips. All tests ran against unchanged runtime source `6b7fe857`. Audit conclusion: exercised core workflows pass; five specific functional/design findings remain open.

## Product subtraction implementation — 2026-10-19

John approved removing unnecessary interface and code before further expansion.
The implementation keeps conversation as home and reduces competing destinations:

- Updates is the single top-level attention entry. Catch-up and owner decisions
  move inside it; the separate Activity dialog and conversation preview are deleted.
  The misleading Saved update filter is removed. Explicit message bookmarks and
  per-reader read boundaries remain intact.
- Delete the human Squads, referrals, bounties, retention, open-questions, landing
  queue and recipe-catalog modules, their exclusive tests/styles and all static
  packaging references. Keep persisted records, server APIs and agent capabilities.
  This is a human product-surface cut, not data destruction or an API migration.
- Remove public-work and receipts links from login. Invite entry leads with the
  invite field; request access remains available through a deliberate disclosure.
- Replace six agent-specific paste blocks with one deployment-aware onboarding
  block. Preserve invitation fragments, advertised proof difficulty, identity
  reuse, credential isolation and truthful connection limits.
- Remove revision/hash boilerplate from the ordinary action heading while
  retaining exact-result identity and provenance in the underlying reader.

Implementation order: remove entry points and callers, delete dedicated modules,
repair asset manifests, adapt browser journeys to the remaining routes, then
verify the same draft, permission, pagination and stale-response guarantees.
Do not weaken those guarantees to accommodate a smaller interface.

Retained deliberately: attention Refresh is still a recovery control for failed
or externally changing queues; notification settings, connection controls,
permission decisions, stored obligations, and diagnostic access remain available.
No backend economic feature or persistent schema is removed in this pass.

Local evidence so far: lint passes with zero errors (289 existing warnings),
43 client/Updates/roster unit tests pass, seven access/owner paging/race journeys
pass at desktop and phone widths, and the native WKWebView first-use journey
passes account creation, room entry, confirmed message, durable draft and close/
reopen. The native screenshot is `/tmp/room-subtraction-native.png`. Separate
entry/collaboration/reconnect checks passed 10 cases; onboarding HTTP tests pass
2 cases. Remaining navigation/permissions and broader affected qualification are
recorded at the next checkpoint. These are simulated participant journeys, not
real-human research. No production deployment or notarized distribution claimed.

### Subtraction qualification checkpoint

Implementation: commits `f40ec67d` through `c59b2cbd`, published to draft PR #4288.
The subtraction slice changes 53 files with 193 insertions and 3,094 deletions.
Thirteen Updates/mobile-header browser cases pass. All nine permission cases pass
across the repaired runs, including leaving Updates while a queue refresh is in
flight. The seven access cases pass; an additional case confirms join requests
have no unsupported Open button. Twenty-five packaging, historical migration,
mobile-doc and touch-target checks pass, plus the genuine v27 upgrade writer-fence
case and three landing checks. Retired assets are recognized only for packaging
historical commits; they are absent from the current deployment manifest.

Affected qualification selected 250 files: 1,716 tests passed, one skipped and two
failed on historical-package recognition. Both failures were repaired and pass
in the 25-test focused run. The earlier 59-case browser batch had 52 passes and
seven obsolete-route/focus failures; all seven pass after route updates. Do not
present either original batch as an entirely green run. Broad local `npm test`
was started before the final fixture repairs and is not frozen-head evidence;
hosted Node24 remains required for release. The earlier local Node26 OG golden
mismatch remains a known runtime qualification concern, not a waived check.

Screenshots: `/Users/johnpotter/Documents/ChatGPT/project room/outputs/product-subtraction-20261019/native-room.png`
and `mobile-room.png` in the same directory. These show native WKWebView and a
390px browser fixture, respectively; they are not physical-device or human-study
qualification. Refresh recovery, stored records and agent APIs were deliberately
retained. No merge, deployment, signing or notarization is claimed here.

## Attention accuracy and deletion pass

1. Feed and badge must observe room changes without requiring Close/reopen.
   Coalesce changes, fence reads to the current session, retain the reader's
   page budget and preserve focus/scroll; never replay an uncertain action.
2. Include pending permission upgrades, with accurate wording, for authorized
   membership administrators. Do not expose owner-only invitation data to admins.
3. Apply Mentions filtering to the whole destination. Reuse existing approval,
   partial-grant and stale-response controls rather than invent a new mutation path.
4. Delete repeated row kind/state text and the redundant catch-up count. Keep
   pagination announcements accessible and recovery controls where needed.
5. Rehearse mentions arriving live, membership review, modal return, drafts and
   narrow layouts. Preserve previous result/agent status semantics and reuse
   unchanged-source evidence rather than rerun unrelated studies.
6. Further deletion decisions: retain saved messages, real permission decisions,
   exact-result provenance and recovery; do not cut controls merely because the
   current view is quiet. Stylesheet changes are excluded while another agent
   holds that file. No new dashboard, workflow engine or onboarding wizard.

### Implemented refinement and verification

Live changes now coalesce into attention reads. Pending user actions cancel
queued refreshes, and unchanged rows retain their DOM nodes. Refresh preserves
focus and scroll and cannot replay an uncertain action. Pending permission
upgrades now enter the feed for membership administrators with correct wording;
owner-only invitations remain owner-only. Existing decisions remain the only
approval path. Requests are not duplicated as generic rows, Mentions hides the
decision section, and decisions precede informational updates on narrow screens.

Deleted: duplicate request cards, visible routine kind/state metadata, redundant
catch-up/decision counts, the outer nested attention frame, the no-op visible()
filter adapter, obsolete integration comments, and Approve partial when only one
permission is requested. Keep multi-permission partial review, exact-operation
retry, separate private handled/dismissed semantics, bookmarks and recovery.
Those still have meaningful behavior; hiding them would not remove their domain
semantics. Server/API records remain intact.

Found and fixed during verification: removing unsupported Open buttons had also
removed a neutral retry for an uncertain Open whose source disappeared. Exact
retry remains available; unsupported new actions do not return. Unchanged live
refreshes previously replaced focused rows; repaint suppression and cancellation
now prevent that interruption.

Evidence: 1,919 affected checks passed (one skip), 12 Updates browser cases passed,
16 access/permission cases passed, 19 projection/client unit checks passed before
removal of the no-op adapter test, and the final focused single/multiple-permission
checks cover removal of the meaningless subset action. Native WKWebView first-use,
message confirmation, durable draft and window reopen passed. Lint has zero errors
and existing warnings. Subsequent presentation-only adjustments were checked in
their affected browser journeys. Screenshots are in
`/Users/johnpotter/Documents/ChatGPT/project room/outputs/attention-refinement-20261019/`.

The earlier broad run finished with 11,336 pass, 31 skip, five failures: four
subtraction fixture/packaging failures have focused repair evidence; the prior
Node26 receipt-image golden mismatch remains. This is not frozen-head full-suite
qualification. Hosted checks, integration and production deployment are still
separate release steps. No physical mobile, real-human or live-provider claim.

## Connected result surface (2026-10-20)

Implement the real flow using existing ownership boundaries. Keep chat-first assistant requests and pasted/attached material as the entry; do not invent a second task or execution system. Reuse focused work/discussion/context and persisted continuation contracts (qualified by the experiment and transport journey).

1. The result-reader owns a responsive pinned surface: alongside conversation on wide screens; existing contextual reading on narrow screens. Keep exact receipt/version and withdrawal checks unchanged.
2. Desktop feedback moves to the existing source-thread composer while retaining the result. Feedback remains a reply to the exact evidence message. On narrow screens feedback returns focus and space to the composer.
3. A new result must not silently replace an open older version. Closing restores an available original control or the composer. Resizing must preserve keyboard focus and unsent feedback.
4. Preserve the Results-list reader within its modal until the user chooses Reply; do not make an inaccessible background panel behind an open modal.
5. Extend the existing transport journey and result tests with desktop/phone placement, concurrent update, draft and resize checks. Reuse current assistant-entry and attachment tests; no inference-based authority or configured-assistant claim.
6. Regenerate source manifest after source edits. Qualify browser, native-shell and affected contracts. Record implementation vs deployment and any remaining release gates separately.

Implemented in the existing reader and shared stylesheet, with no new editor, work model, endpoint or stored state. Wide-screen reading and exact-version feedback now coexist; phone feedback returns to the existing composer. Desktop/phone screenshots were inspected.

Qualification: 59 result/native-text browser cases pass after updating obsolete placement/close assertions; five comparison browser cases passed with unchanged source. Thirteen composer/paste/upload cases and five feedback unit cases pass. Lint has zero errors and existing warnings. Native WKWebView first-use, rendered message, durable draft and window reopen pass; this native smoke does not certify the new docked-result interaction itself. Browser runs used Node 26.8.2, not CI's Node 24.

Evidence: `/Users/johnpotter/Documents/ChatGPT/project room/outputs/connected-result-20261020/`, including the original seven assertion failures and the successful corrected run. Two old narrow-screen assertions expected previously removed explanatory copy; exact result-body and provenance checks remain. Private-draft refusal, exact reply identity, withdrawal, resizing and focus checks remain enforced.

Remaining release gates: `verify:affected --base=HEAD --budget=120` stops at the expected manifest drift for the two changed runtime assets. `scripts/CANDIDATE-MANIFEST.json` is held by Grok's live `grok-starters-c1` claim; coordination request sent on the bus. Do not overwrite that claim or call this a qualified release. Regenerate and inspect the manifest when ownership is available, run affected/full required qualification on CI's runtime, reconcile the PR's existing hosted failures, then integrate and deploy. This checkpoint is local and not deployed. Real-human, physical-device and live-provider qualification remain separate.

### Manifest handoff follow-up

John explicitly assigned the manifest to Codex after the checkpoint above. Peers were notified and the board records that assignment; the room registry still reported Grok's lease, so no registry transfer is claimed. Regenerated this checkout's manifest: exactly the result-reader and stylesheet asset hashes changed, with no schema, package or deployment changes.

Node 24.21.0 qualification now gets past manifest validation. The affected run reports 2,010 pass / one failure: an existing permission-label assertion expects `complete_work` instead of the UI's `Complete work`. The rendered Approve control remains disabled. Lint passes with existing warnings. Full-suite qualification is being retained separately; none of these local results imply a production release.

Final local result: repaired that stale assertion and explicitly asserted that the unavailable full-grant button stays disabled; all 27 permission retry cases pass. The full Node 24.21.0 run completed with **11,341 passed, 31 skipped, zero failures** (451 seconds). It includes the repaired test; runtime source stayed unchanged during the run. Logs are retained beside the earlier evidence as `connected-result-full-node24.log`, `connected-result-affected-node24.log`, `connected-result-permission-node24.log` and `connected-result-lint-node24.log`. Manifest and regression repair are commit `7a797646`. Hosted checks on the updated PR remain distinct from these local results; merge/deployment and real-human/device/provider qualification are not completed by this receipt.

## Finish the chat–result–return flow: execution plan (2026-10-20)

The [collaboration experiments](COLLABORATION-EXPERIMENTS.md) informed the choice of a conversation-first surface with contextual reading. Their automated results do not establish a human usability winner. This next slice completes that real flow rather than adding another work model.

### Outcome and boundaries

A person starts in chat, receives a result, replies to that exact version, leaves, and resumes without reconstructing context. Desktop keeps the pinned result beside the composer; narrow screens use contextual reading and return to the composer for feedback. Mac and web share the reader implementation. Existing conversation recovery owns drafts and thread selection. Existing agent work/discussion/checkpoint APIs own continuation. No new editor, approval mechanism, execution queue, or mandatory task form.

### 1. Repair the release baseline

Read hosted logs for the exact PR head. The first known failure is documentation reachability, repaired by the link above without editing the index another agent holds. Inspect completed browser shards next. Reproduce each actual failure locally, identify whether the interaction broke or a test still targets a removed control, and preserve the original output. Updated tests must use the visible supported path and retain their authority, draft, focus and exact-version assertions. Never turn missing functionality into a passing test by skipping it.

### 2. Restore the inspected result safely

The recovery audit shows that thread/channel/composer recovery already exists. Add a small reader-owned selection record to the same storage chosen for drafts: tab session storage on web, local storage in the Mac shell. Save only room/member scope, work ID, completion event ID, evidence version and bounded display provenance, with a twelve-hour expiry. Do not persist result bodies or credentials. Use one bounded record, not an unbounded per-room cache.

Only conversation-side reading is resumed automatically; a Results settings-modal inspection does not become a new background panel on reload. Reply on desktop makes the selected result conversation-side. Explicit close removes the record. Access-end cleanup preserves selection only for the same recovery cases as drafts, and clears rendered text regardless. A different scope, invalid/oversized record, expired selection or inaccessible work must not restore.

Run restoration once after the initial authorized snapshot and draft restoration, respecting explicit deep links. Re-fetch the saved completion through the existing result API and validate completion/evidence identity. Reuse current withdrawal and stale-response guards. Do not replace the saved version with the current receipt. Avoid stealing focus from the recovered composer. User navigation or closing must invalidate a pending read. A newer completion should label an earlier inspected version, not replace it.

### 3. Connect feedback to continuation

Extend the existing real local transport journey. Verify the human reply refers to the pinned evidence message, is posted once with the intended audience, and appears in the agent's focused work discussion/checkpoint stream. Exercise reconnect/restart and agent revision using the existing contracts. No fabricated provider invocation or inferred approval. Reuse unchanged contract coverage rather than adding an alternative mock agent implementation.

### 4. Simplify the completed interaction

Inspect desktop and narrow screenshots with the reader open, then with feedback focused. Remove only demonstrably duplicated status/actions in this path. Preserve essential version, audience, withdrawal and failure information. Keep comparison and secondary controls contextual. Check keyboard order, return focus, long content, resizing and overflow. Avoid broad unrelated cosmetic edits while release failures remain.

### 5. Qualification matrix

Exercise reload with unsent feedback; exact older version after later completion; explicit close followed by reload; expired/malformed/wrong-scope selection; access loss; withdrawn text; blocked storage; and desktop/mobile transitions. Assert both the useful result and the absence of unintended writes or cached sensitive text. Use existing browser fixtures and native WebKit smoke; distinguish simulated users and browser phone viewports from real humans and physical devices.

After source stabilizes, regenerate the candidate manifest, inspect its exact asset changes, run affected checks, lint and required full qualification on Node 24. Preserve failing runs and focused repair evidence. Runtime changes justify fresh qualification; documentation-only updates do not justify repeated expensive execution.

### 6. Integration, deployment and completion

Checkpoint source and evidence together, push the existing PR and inspect exact-head hosted checks. Reconcile current main and peers before acquiring the merge/deployment lanes. Merge only after required checks pass; preserve others' ancestry and work. Deploy through the documented release lane, then independently verify deployed revision, readiness, both entry routes, assets and a disposable collaboration journey. Record actual completion separately from reported CI/deploy success.

Developer ID/notarized Mac distribution remains deferred. Real-human, physical-device and live-provider qualification remain explicit limits. Any unfinished gate must remain listed with a concrete next action; do not describe a local checkpoint as a released v1.

### Implementation and qualification checkpoint

Implemented reader selection recovery in the existing controller, using the draft controller's chosen storage and scope. The persisted record contains only scope, expiry, work ID and pinned receipt identifiers; provenance and content come from the fresh authorized response. Explicit close clears selection; unload/session-expiry recovery preserves identifiers while clearing the visible reader. Restoration respects explicit URL fragments and does not focus the reader. Closed/replaced views reject late responses. No endpoint, schema or agent execution change.

The public marketing footer is now absent inside an active room. Its overlap with large-text work controls reproduced in the existing help journey; that case passes after removal. The public signed-out footer remains available. No extra controls were introduced.

The hosted contract failure was an orphaned experiment document, now linked above. Browser failures targeted removed direct Catch up controls, assumed secondary work details expanded on navigation, or asserted old verbose action-context copy. Updated them to use visible Updates navigation, focused work cards with explicit Details disclosure, and actual pinned evidence URLs/submitted command versions. Preserved audience, ownership, session, revision and draft assertions. The shared-cookie test now opens the protected brief before replacing the cookie, so it exercises the intended mismatched response rather than timing out after the earlier Updates request correctly ends access.

Evidence: 71 result/comparison/browser cases pass (including seven new recovery/boundary scenarios); 88 of 89 broader action/invitation/session/layout/draft/first-use cases passed, followed by the repaired cookie case passing independently. Five other hosted repair cases passed; the large-text overlap case failed in that run and then passed after the footer repair. Affected checks pass 435/435. Lint passes with existing warnings. Native WebKit signup, messaging, durable draft and window reopen pass. Screenshot of restored pinned feedback inspected. Full Node 24 qualification is running. Evidence directory: `/Users/johnpotter/Documents/ChatGPT/project room/outputs/resume-flow-20261020/`.

Fresh GitHub protection readback requires only `room/release-lease`, consistent with John's prior removal of mandatory CI contexts. Other hosted checks remain useful advisory evidence and actual failures require assessment. The existing guarded coordinator must bind the real lease/head/base; do not reinstall the older five-context protection. Initial readback finds RELEASE-PAUSE, MERGE-SLOT and ROLE-DEPLOYER unclaimed; re-read immediately before acting.

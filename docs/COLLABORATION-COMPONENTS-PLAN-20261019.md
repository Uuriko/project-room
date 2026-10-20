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

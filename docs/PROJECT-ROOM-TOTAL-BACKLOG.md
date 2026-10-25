# Project Room total backlog

Active scope: [six-outcome delivery plan](FOCUSED-DELIVERY-PLAN.md). It explicitly narrows earlier feature commitments; the detailed inventory remains evidence, not the active execution queue.

Captured 2026-10-18; local baseline d3ae60e0. **773 accountable entries**: 288 execution/reconciliation tasks, 34 idea experiments, 48 historical native acceptance checks, 208 issue reconciliations, and 195 PR reconciliations. These counts overlap in underlying scope; they are not a count of distinct defects.

This is the full captured inventory, not a priority shortlist. Existing source requirements remain binding. A task to reconcile or qualify a capability does not assert it has never been built. Schema 41 and earlier measured gains are local qualified checkpoints; the overall architecture overhaul remains incomplete.

## How this stays complete

1. Discover sources: active/archived chats, local plans and transcripts, agent bus/Room records, branches, patches, issue/PR history, code contracts and user feedback. Record inaccessible or unread sources explicitly.
2. Extract atomic obligations with original source, acceptance criteria and any later decision that changed them. Split bundled issues. Add newly discovered tasks before closing a parent.
3. Normalize into stable IDs and link duplicates; never silently discard a source item. Preserve deferred ideas with a reopen condition.
4. Attach owner, dependencies, implementation status, exact revision and acceptance evidence as each item is triaged. The current JSON deliberately does not fabricate unknown owners or dependency graphs.
5. Distinguish proposal, required work, locally qualified, integrated, deployed and verified. A closed issue, merged PR or green unrelated test is not sufficient completion evidence.
6. Refresh moving inventories and compare changes. Require a disposition for every source obligation; report unread sources, orphaned tasks and unmet acceptance conditions.
7. Execute B00–B09 from the build-to-completion plan. Newly discovered scope changes that plan through explicit dependency and acceptance updates; it does not erase prior work.
8. Complete a task only with evidence; retain superseded/cancelled IDs and the linked replacement or explicit decision.

## Coverage and limitations

- All 31 delivery-ledger IDs and all 34 brainstorming proposals have mapped entries.
- Open GitHub lists contain 208 issues and 195 PRs at capture. Titles/URLs are fully preserved below and in JSON. Bodies, bundled findings and current implementation still require individual reconciliation.
- Recent chat inventory was limited to the 50 returned entries, with selected relevant recent turns read. Older pages, archives and inaccessible agent history are outstanding discovery work; no claim that every conversation was read.
- Cross-chat findings include native stack integration, retained retry/auth fixes, deferred actionable overflow, agent communication gaps and shelved unified messaging/Gmail work. Their current status must be verified.
- The CTO strategy was read with output limits; its headings, capability sections and selected other sections were reviewed. Complete section-by-section acceptance/current-code reconciliation remains COV work.
- Local native roadmap acceptance checks are included verbatim as historical checks, not 48 asserted current defects.
- Existing measurements are synthetic/local unless their receipts say otherwise. No new product benchmark or release qualification was performed for this backlog.
- No code deployment, automation activation, money action, merge or closure is authorized or performed by creating this document.

## Source register

- `docs/ARCHITECTURE-EXECUTION-PLAN.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `bf36419a60d1a5d94f4e8062548bac52eb80d6f32acce512796911a55cba3cc7`.
- `docs/MESSAGE-REPLAY-ISOLATION-PLAN.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `fde45494ee0ad5d073c71c26f7839afcf9fac8141c1933787a3c45205e6196f0`.
- `docs/FRONTIER-INFRA-RESEARCH-2026-10-18.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `2f7fe19690521ffa12e7a90461c6ccd6a0a6bf424d9bc7aa16725d39c9862500`.
- `docs/STARTUP-RESEARCH-AND-PRODUCTIVITY-STRATEGY.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `4ef070a7d55909fe4871e1881f9490b00f12015f7b9308913d6d4934aa149ae1`.
- `docs/QUALITY-AND-PRODUCTIVITY-SCORECARD.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `f5286563e99a5f36755a188545c66d98ad8a8f254f622a634f1e640aba2e94c8`.
- `docs/DELIVERY-LEDGER.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `30e7c010ed535423d9d6bb7c938e283bb57e888df043bb6e496b17ef3d2cc263`.
- `docs/AUTOMATION-RESEARCH-AND-EXECUTION-DESIGN.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `caffa30ac1a48b858e647ac5f4508ae80356cd85ae684d3e4a59b2656be3b587`.
- `docs/ADAPTIVE-PROJECT-ROOM-MASTER-PLAN.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `d9b2ed5950f9795f5b610b4eab58dd9eec083b0f1d44b9a0d9209b4daa1ec579`.
- `docs/BUILD-TO-COMPLETION-PLAN.md` — read and mapped; detailed acceptance requirements remain binding; SHA-256 `f84dde412604b68fd05179c2e608b0745efcd56d4b95fe5bb1b4f6856b739839`.
- `/Users/johnpotter/Documents/ChatGPT/project room/outputs/architecture-decision-20261017/PROJECT-ROOM-CTO-STRATEGY.md` — selected sections/checklists reviewed; complete line-by-line current-code reconciliation remains open; SHA-256 `db57e851ad89ea1312cb411b46a2bde6299ab7dddd631bb6ebf803eb0f351d0e`.
- `/Users/johnpotter/Documents/ChatGPT/project room/claude-recovery-20261005/MACOS-SHELL-DESIGN-AND-ROADMAP.txt` — selected sections/checklists reviewed; complete line-by-line current-code reconciliation remains open; SHA-256 `0891f06225405fc79247fe9af0f0b2cc8ee26afb49d8c32573c02858996de354`.
- `/Users/johnpotter/Documents/ChatGPT/project room/claude-recovery-20261005/PEER-REFINED-EXECUTION-PLAN.txt` — selected sections/checklists reviewed; complete line-by-line current-code reconciliation remains open; SHA-256 `db81b30911c7a2cb7311426383cec91cedf2e39eb11ad6e8113968b3e69d488f`.

Selected chat sources: **Map agent communication gaps** (`01a0ee9d-76ed-7e80-acdc-02177dc7ca3c`); **Continuing from Continue Project Room Development: Continue…** (`01a08f26-bba4-7c93-833f-a3ae4a11511f`); **Simplify Gmail inbox connection** (`01a0cab4-b6ee-7753-92d8-7c6f0f573659`); **Polish Project Room apps** (`01a11307-fe95-7160-abe8-46e5f31fdb05`). Current conversation supplies the 34 proposal records.

## Execution and reconciliation checklist

### COV: Source coverage and commitment preservation

Package: B00. Ledger: G1, AU3.

Acceptance: Every source has a coverage state; every extracted obligation has an ID, disposition and evidence or an explicit unresolved gap.

- [ ] **COV-01** — Inventory active and archived Project Room chats, local session indexes, attachments and accessible agent records; record inaccessible sources.
- [ ] **COV-02** — Read remaining relevant history in pages; extract obligations, decisions, reversals, acceptance criteria and unresolved questions.
- [ ] **COV-03** — Reconcile all 42 CTO strategy sections and appendices against implementation, not merely against later plans.
- [ ] **COV-04** — Reconcile architecture stages, build packages, delivery ledger, research, scorecards and adaptive plans without replacing their detailed requirements.
- [ ] **COV-05** — Preserve all 34 brainstorm proposals with separate experiment decisions and cross-links for overlapping ideas.
- [ ] **COV-06** — Inventory local branches, worktrees, patch bundles, code drops and historical recovery files; identify the original source and missing exports.
- [ ] **COV-07** — Reconcile the 208 captured open issues individually; split bundled findings into independently accountable child tasks.
- [ ] **COV-08** — Reconcile the 195 captured open PRs individually; identify duplicate implementations, conflicts, supersession and missing dependencies.
- [ ] **COV-09** — Refresh GitHub inventories and compare additions, closures, reopened items and changed heads before execution.
- [ ] **COV-10** — Read relevant Room coordination history, agent replies and disk-bus records; distinguish unavailable agents from disagreement.
- [ ] **COV-11** — Record baseline, owner, dependency, acceptance evidence, source revision and removal condition for each implementation slice.
- [ ] **COV-12** — Maintain explicit proposed, required, local-qualified, integrated, deployed, verified, deferred and superseded states.
- [ ] **COV-13** — Add tasks discovered during implementation and review before closing their parent; preserve the original wording and provenance.
- [ ] **COV-14** — Require a linked replacement or explicit decision for cancellation; never equate a closed PR with delivered capability.
- [ ] **COV-15** — Audit coverage at each checkpoint and expose unreviewed sources and orphaned commitments instead of reporting false completeness.

### PRO: Product direction, discovery and economics

Package: B00–B07. Ledger: P2, M1, M2.

Acceptance: Observed target-user journeys, explicit product decisions and measured adoption/effort support the scope.

- [ ] **PRO-01** — Validate shared persistent work across people, agents, time and devices as the primary product promise.
- [ ] **PRO-02** — Choose initial user groups and repeated workflows through observed collaborative building and research sessions.
- [ ] **PRO-03** — Map the complete first-session and return-session journey; identify dead ends, repeated explanations and coordination burden.
- [ ] **PRO-04** — Inventory actual feature usage; classify what to preserve, improve, isolate, remove or keep deferred.
- [ ] **PRO-05** — Define conversation-first navigation with one useful default assistant presence and contextual specialist access.
- [ ] **PRO-06** — Set outcome-based success criteria, quality/cost guardrails and baseline comparison workflows before optimizing.
- [ ] **PRO-07** — Measure activation, time to first useful accepted result, repeat use, retention and reasons groups abandon work.
- [ ] **PRO-08** — Measure cost per accepted outcome, infrastructure cost, support burden and sustainable service limits.
- [ ] **PRO-09** — Clarify pricing, credits, actual settlement and availability in product copy; remove unsupported earnings claims.
- [ ] **PRO-10** — Test product terminology, onboarding explanations and release communication with unfamiliar humans and agents.
- [ ] **PRO-11** — Define feedback intake, support ownership and a route from user friction to a tracked repair and regression case.
- [ ] **PRO-12** — Resolve which pilot capabilities are mandatory and which require demand evidence before expansion.

### ARC: Finish the architectural overhaul

Package: B01–B09. Ledger: A1, A2, A3, A6, A7.

Acceptance: Representative features stay within owned domains; forbidden dependencies fail; old paths are removed after migration evidence.

- [ ] **ARC-01** — Inventory RoomStore, HTTP and client composition responsibilities, call graphs, dynamic entry points and dependency cycles.
- [ ] **ARC-02** — Define narrow ports for Identity, Room, Work, Artifacts and Delivery with one authoritative owner per state transition.
- [ ] **ARC-03** — Move domain behavior out of transport handlers and platform adapters; keep HTTP, MCP, CLI and A2A behavior consistent.
- [ ] **ARC-04** — Use typed contracts for new boundaries and runtime validation for network, tool and persisted data.
- [ ] **ARC-05** — Replace universal-store access with operation-specific repositories and transaction-scoped command contexts.
- [ ] **ARC-06** — Separate application composition from domain rules; prevent core imports of optional extensions and platform code.
- [ ] **ARC-07** — Consolidate requests, attempts, claims, leases, effects and results without conflating their distinct meanings.
- [ ] **ARC-08** — Isolate commerce, public-work and shelved inbox dependencies from ordinary room startup and conversation.
- [ ] **ARC-09** — Replace broad client snapshot refresh with domain subscriptions, selectors and owned rendering regions.
- [ ] **ARC-10** — Generate asset catalogs and repeated contract artifacts from declared sources; eliminate manual duplicate registries.
- [ ] **ARC-11** — Enforce architectural boundaries and shrinking dependency cycles in CI with explicit temporary exceptions.
- [ ] **ARC-12** — Track every compatibility adapter, dual writer and legacy caller with owner, retirement condition and expiry review.
- [ ] **ARC-13** — Remove replaced code, serializers, storage and dead features after caller/data/migration verification.
- [ ] **ARC-14** — Measure unrelated files/domains touched, merge conflict burden and new-contributor time on representative changes.

### MSG: Canonical message storage and bounded reads

Package: B01. Ledger: A1, A2, A2.1.

Acceptance: Node and Worker command/read parity, privacy and ordering hold; writes scale with touched data; schema-41 evidence is requalified on the integrated tree.

- [ ] **MSG-01** — Inventory all direct message-array readers and replace them with bounded ordered/recent/typed/metadata contracts.
- [ ] **MSG-02** — Preserve archive and working-set ordering, sequence identity, metadata and legacy recovery exceptions.
- [ ] **MSG-03** — Apply membership, history-floor and redaction filters before materializing protected message bodies.
- [ ] **MSG-04** — Complete Guide/receipt and all other message-producing paths with atomic event, entity, receipt and delivery-intent writes.
- [ ] **MSG-05** — Implement transaction-scoped message ancestry, receipt bindings, touched IDs and shared metadata.
- [ ] **MSG-06** — Finish post, edit, reply, reaction, poll, pin, delete and withdrawal command parity, including rejected operations.
- [ ] **MSG-07** — Keep canonical entity revisions and idempotency checks authoritative across same-head replacement, reopen and revocation.
- [ ] **MSG-08** — Certify init, import, restore and backfill completeness rather than silently treating partial indexes as canonical.
- [ ] **MSG-09** — Finish canonical message cutover; remove opt-in dependence, temporary restoration paths and unnecessary dual serialization.
- [ ] **MSG-10** — Preserve schema-41 replay/serving isolation and atomic head promotion; requalify against contemporary main.
- [ ] **MSG-11** — Prove forward migration, resumability, corruption detection, semantic comparison and reverse migration on supported versions.
- [ ] **MSG-12** — Measure SQL statements, decoded bytes, CPU, allocation, database growth and WAL at 1k, 10k and 100k messages.

### DAT: Independent aggregates and data lifecycle

Package: B02–B06. Ledger: A3, R2.

Acceptance: Independent aggregates preserve cross-domain atomicity, provenance, restore and retention semantics without whole-room serialization.

- [ ] **DAT-01** — Give work, attempts, artifacts, effects and delivery records independent storage, revision and repository ownership.
- [ ] **DAT-02** — Define cross-aggregate transactions and explicit repairable projections where a shared transaction is impossible.
- [ ] **DAT-03** — Preserve evidence lineage from intent and request revision through attempt, artifact, checks and acceptance.
- [ ] **DAT-04** — Build resumable aggregate migrations with fixtures, validation, crash recovery and reversal.
- [ ] **DAT-05** — Implement bounded replay builders with chunked staging, concurrent-write catch-up and constant-size publication.
- [ ] **DAT-06** — Measure total replay and initialization cost as well as publication time; address the remaining expensive whole-fold paths.
- [ ] **DAT-07** — Benchmark incremental dependency views against full recomputation and select by actual update/read costs.
- [ ] **DAT-08** — Implement precise dependency invalidation and independent full-reference equality/property checks.
- [ ] **DAT-09** — Unify safe cursor/walk semantics across messages, inboxes, boards, exports and changing datasets.
- [ ] **DAT-10** — Define archive, retention, deletion, legal-hold and backup-resurrection behavior by data class and product obligation.
- [ ] **DAT-11** — Qualify export/import and backup/restore byte integrity, foreign-key order, large-row limits and semantic round trips.
- [ ] **DAT-12** — Track index, projection and cache freshness; make fallback and per-record failures visible and diagnosable.

### EXE: Canonical execution, control and recovery

Package: B02–B04. Ledger: A3, R3, R4, A6.

Acceptance: A changed request or stale host cannot regain authority; duplicate/unknown effects are reconciled; an interrupted real task continues correctly.

- [ ] **EXE-01** — Define request, attempt, claim, control and result state machines with explicit legal transitions and one writer.
- [ ] **EXE-02** — Bind every execution and result to the exact request revision, principal, host, lease and fencing generation.
- [ ] **EXE-03** — Make stop, pause, redirect and cancellation acknowledgement truthful about execution and already-started effects.
- [ ] **EXE-04** — Prevent stale attempts from publishing current results or stopping newer attempts through stale budget reports.
- [ ] **EXE-05** — Implement durable operation identities with scope and payload binding across retries and transports.
- [ ] **EXE-06** — Journal effect intent, dispatch, acknowledgement and unknown outcome; distinguish idempotent sinks from unreconcilable effects.
- [ ] **EXE-07** — Version execution context, prompt, model, tools, schemas, resources and policy; refuse incompatible resumes explicitly.
- [ ] **EXE-08** — Persist checkpoints and attempt journals across process crash, laptop sleep, reconnect and application restart.
- [ ] **EXE-09** — Reconcile lost acknowledgements and pickup races without duplicate execution or silently discarded attempts.
- [ ] **EXE-10** — Preserve Retry-After minima, permanent-auth refusal and assistant_run_owned behavior from earlier native fixes.
- [ ] **EXE-11** — Bind spend, rounds, tool calls and budgets to the correct attempt; make budget stop/pause atomic.
- [ ] **EXE-12** — Expose readiness and host capability separately from registered identity, declared availability and observed execution.
- [ ] **EXE-13** — Prove fresh-agent continuation using only durable state, including unknown external-effect outcomes.

### SCH: Durable scheduling and automation safety

Package: B03. Ledger: A4, R3, AU1, AU4.

Acceptance: Committed due work survives failures; dispatch is fenced, bounded and authorized; reads do not trigger hidden business mutation.

- [ ] **SCH-01** — Inventory existing jobs, alarms, heartbeats, watchers and manual automation before introducing another scheduler.
- [ ] **SCH-02** — Commit due records and outbox intents atomically with the originating state change.
- [ ] **SCH-03** — Remove request/read-triggered flushes and full per-request job scans.
- [ ] **SCH-04** — Implement due indexes, leases, fencing, deduplication and bounded coalescing.
- [ ] **SCH-05** — Add retry backoff, jitter, Retry-After handling, deadlines, cancellation and dead-letter/recovery handling.
- [ ] **SCH-06** — Revalidate actor authority and resource revisions immediately before delayed effects.
- [ ] **SCH-07** — Repair lost wakeups, abandoned leases and restart gaps through deterministic reconciliation.
- [ ] **SCH-08** — Bound automation causation depth, concurrency, total cost, retry storms and feedback loops.
- [ ] **SCH-09** — Provide observe, propose, reversible-internal and explicitly authorized external execution modes.
- [ ] **SCH-10** — Record automation version, trigger, cause, inputs, action, outcome and stop reason for inspection.
- [ ] **SCH-11** — Keep unchanged success quiet; measure useful alerts, interruptions and exception-handling effort.
- [ ] **SCH-12** — Audit stale recurring reminders and shelved workflows; propose explicit cleanup without silently reactivating them.

### ISO: Room placement, isolation and scale

Package: B06. Ledger: A5, R5.

Acceptance: One accepting placement epoch per room; migration/rollback preserve identity and cross-room behavior; overload does not cascade.

- [ ] **ISO-01** — Replace the shared-room bottleneck with a versioned room-placement directory and per-room authority.
- [ ] **ISO-02** — Specify synchronous identity/membership checks and cross-room inbox/discovery projections.
- [ ] **ISO-03** — Implement freeze, checkpoint, transfer, verify, switch and source-fence migration stages.
- [ ] **ISO-04** — Prove no dual accepting writers during retries, partial cutover, rollback and process failure.
- [ ] **ISO-05** — Preserve global identity, room links, notification routing and cross-room continuity through movement.
- [ ] **ISO-06** — Measure cold starts, hot rooms, subscriber fan-out, storage limits and noisy-neighbor effects.
- [ ] **ISO-07** — Implement admission control, load shedding, fairness and per-identity rate budgets with shared-IP backstops.
- [ ] **ISO-08** — Reject or reconcile timed-out writes honestly; prevent overload from accumulating invisible late mutations.
- [ ] **ISO-09** — Define scaling and extraction thresholds that would justify additional services rather than adding them by default.

### UI: Human experience, accessibility and continuity

Package: B04–B05. Ledger: P2, A6, M2.

Acceptance: Real users complete creation, collaboration, review, interruption and return journeys without lost input, misleading state or accessibility failures.

- [ ] **UI-01** — Build a coherent conversation → work → result → review → continuation journey with contextual controls.
- [ ] **UI-02** — Show compact return context, changed decisions, waiting work and honest last-observed availability.
- [ ] **UI-03** — Preserve successful bounded rendering and unchanged-DOM paths; optimize only measured remaining refresh costs.
- [ ] **UI-04** — Make send feedback immediate and distinguish pending, committed, unconfirmed and failed outcomes.
- [ ] **UI-05** — Recover lost send acknowledgements and attachment drafts/retries without accidental duplicate sends.
- [ ] **UI-06** — Preserve text, attachments, focus, selection, scroll and navigation through room changes, errors and reconnects.
- [ ] **UI-07** — Implement durable scoped drafts and explicit conflict recovery across close, crash and account changes.
- [ ] **UI-08** — Fix sign-in, invite creation, invite display and join-dialog flows, including unavailable OAuth and verification remedies.
- [ ] **UI-09** — Make Back, deep links and board-to-record navigation restore meaningful location and keyboard focus.
- [ ] **UI-10** — Fix required-field markers, validation messages and human remedies; never silently ignore form submission.
- [ ] **UI-11** — Expose review queues, send-back/resume, owner verification and acceptance criteria in the actual human interface.
- [ ] **UI-12** — Build truthful account-level attention, roster, money and evidence drill-down views without mixing cents and credits.
- [ ] **UI-13** — Qualify keyboard, screen-reader, IME, reduced-motion, zoom, narrow/mobile layouts and reachable touch targets.
- [ ] **UI-14** — Define notification permission, grouping, expiry, privacy, mute and interruption budgets; opening is not acceptance or execution.
- [ ] **UI-15** — Test comprehension of proposed, authorized, attempted, observed, verified and accepted states.

### ART: Artifacts, previews and reusable work

Package: B04–B08. Ledger: P2, A3, P5.

Acceptance: Humans and agents edit versioned shared results with correct authorization, conflict handling and durable availability.

- [ ] **ART-01** — Implement stable artifact identities, versions, authorship, storage handles and request/attempt lineage.
- [ ] **ART-02** — Provide a shared editable document and an evidence-linked result/diff viewer as complete first artifact types.
- [ ] **ART-03** — Support paragraph/row/selection feedback tied to an expected artifact version.
- [ ] **ART-04** — Preserve simultaneous human and agent edits; evaluate CRDTs for mergeable content with authoritative permission checks.
- [ ] **ART-05** — Qualify offline edits, stale versions, large documents and revocation before accepting queued changes.
- [ ] **ART-06** — Distinguish local-only files from uploaded, durable shared artifacts and verify bytes before reporting availability.
- [ ] **ART-07** — Build trusted interactive renderers with mediated capabilities, input validation and static/text fallbacks.
- [ ] **ART-08** — Provide isolated worktrees, document branches and artifact previews with explicit external-resource limitations.
- [ ] **ART-09** — Expose context, tool, control, effect and verification traces without requiring private model reasoning.
- [ ] **ART-10** — Distinguish deterministic state replay, recorded-tool replay and new stochastic model reruns.
- [ ] **ART-11** — Extract successful workflows into versioned, parameterized recipes with capability, budget and verification contracts.
- [ ] **ART-12** — Require deliberate triggers and notification policy before making a recipe recurring; support edit, rollback and retirement.

### CTX: Context compiler, memory and local evidence

Package: B05–B08. Ledger: P4, R4, AD4.

Acceptance: Relevant authorized evidence arrives with provenance and freshness; corrections/deletions propagate; context improves outcomes at bounded cost.

- [ ] **CTX-01** — Compile intent, constraints, decisions, evidence, artifacts, collaborators, capabilities and unresolved questions into bounded task context.
- [ ] **CTX-02** — Attach source handles, room watermarks, artifact versions, scope and context-policy versions.
- [ ] **CTX-03** — Implement incremental context changes and cache keys that include authorization and source revisions.
- [ ] **CTX-04** — Expose what work is using so humans can add, correct or exclude context.
- [ ] **CTX-05** — Distinguish proposed, accepted, disputed and superseded decisions; repetition must not silently promote assumptions to facts.
- [ ] **CTX-06** — Start with exact references and lexical retrieval; add semantic ranking only against measured recall failures.
- [ ] **CTX-07** — Build a scoped local index for user-designated workspaces with file identity, hashes and extraction versions.
- [ ] **CTX-08** — Qualify index update/delete/rebuild/crash behavior and provide scoped direct-read fallback.
- [ ] **CTX-09** — Track tool availability, version, workspace grants, credential readiness and host capacity without exposing secrets.
- [ ] **CTX-10** — Propagate source correction, deletion, revocation and retention through caches, embeddings, summaries and artifacts.
- [ ] **CTX-11** — Evaluate old critical facts, reversed decisions, contradictory sources, irrelevant history and missing evidence separately.
- [ ] **CTX-12** — Measure retrieval accuracy, missing-evidence failures, context bytes/tokens, update lag, battery/disk cost and repeated explanation.

### API: Agent tools, onboarding and interoperability

Package: B04–B08. Ledger: P1, A6, P5.

Acceptance: An unfamiliar supported agent completes documented journeys with bounded calls and consistent authorization across interfaces.

- [ ] **API-01** — Generate typed SDK contracts, examples and validation fixtures from canonical command/query definitions.
- [ ] **API-02** — Provide field selection, conditional reads, stable pagination, resource handles and explicit omission/partial-error metadata.
- [ ] **API-03** — Add bounded parallel batch reads with declared watermark consistency and per-item errors.
- [ ] **API-04** — Implement progressive tool discovery with a small useful default catalog and task-relevant specialized schemas.
- [ ] **API-05** — Expose capability, effect class, idempotency, cancellation and recovery metadata for each tool.
- [ ] **API-06** — Provide restricted programmatic tool composition with CPU, memory, call, concurrency, output and time budgets.
- [ ] **API-07** — Prefer deterministic read composition first; route every supported effect through authority and effect journals.
- [ ] **API-08** — Unify REST, MCP, CLI and agent-client semantics; validate served contracts against generated sources.
- [ ] **API-09** — Complete cold agent onboarding through identity, first useful work, membership, wake setup and recovery, including empty-board fallback.
- [ ] **API-10** — Fix OAuth protected-resource discovery and authenticated connector compatibility with current protocol qualification.
- [ ] **API-11** — Qualify A2A cards, capability queries, practice-room onboarding and experimental long-running-task adapters where useful.
- [ ] **API-12** — Test supported clients for structured results, resource links, interactive fallbacks and error recovery rather than assuming parity.
- [ ] **API-13** — Measure model turns, transport calls, bytes, tokens, total accepted-task latency and debugging quality.

### MAC: Native Mac integration and host experience

Package: B04–B09. Ledger: A6, P5, R3, R4.

Acceptance: The combined supported native candidate passes real-device journeys; branch-local receipts are not release qualification.

- [ ] **MAC-01** — Reconcile native PRs #2611, #2612, #2614, #2625, #2630 and replacement history against current main.
- [ ] **MAC-02** — Recover applicable #2662 retry/auth/ownership/race protections and #2006 attachment reliability without reviving obsolete stacks.
- [ ] **MAC-03** — Integrate native connection, persistent supervisor, status, Start/Stop and observations as one qualified composition.
- [ ] **MAC-04** — Choose supported OS/hardware and compare actual native value with an installed Safari web app.
- [ ] **MAC-05** — Implement external-browser authentication with one-time bounded human-session handoff and native Keychain custody.
- [ ] **MAC-06** — Qualify origin/frame/session-bound bridges, files/bookmarks and permissions; prohibit generic ambient native execution.
- [ ] **MAC-07** — Prove execution isolation before enabling automatic Mac agent actions; keep host enrollment separate from human login.
- [ ] **MAC-08** — Complete honest start/stop/pause/resume and unresolved-attempt recovery under sleep, crash and disconnect.
- [ ] **MAC-09** — Qualify signed/notarized packaging, updates, uninstall and helper lifecycle on real supported devices.
- [ ] **MAC-10** — Evaluate optional menu bar, shortcuts, share extension, Spotlight, AppIntents, voice and window sharing only through scoped demand and permission tests.
- [ ] **MAC-11** — Reconcile all 48 historical MAC acceptance checks individually; preserve unshipped and optional statuses.

### SEC: Security, privacy and authority

Package: B00–B09. Ledger: A1, A5, A6, A7.

Acceptance: Negative controls reject unauthorized reads/effects across all representations; security and privacy evidence survives migration and release.

- [ ] **SEC-01** — Threat-model humans, agent identities, hosts, guests, delegates, connectors and untrusted retrieved content separately.
- [ ] **SEC-02** — Unify policy evaluation across commands, snapshots, deltas, search, replay, artifacts and exports.
- [ ] **SEC-03** — Fix invite replay, credential rotation, enrollment holder-proof and cross-room peer-DM scope findings.
- [ ] **SEC-04** — Complete own-key membership access and reject prototype-name identities/channels throughout the system.
- [ ] **SEC-05** — Make access review include high-authority owner-delegate grants and revoke active/delayed access consistently.
- [ ] **SEC-06** — Centralize first-party and provider secret scrubbing; test feedback, logs, traces, exports and generated evidence.
- [ ] **SEC-07** — Enforce public publication/consent policy across receipts, directories, sitemaps and every public read surface.
- [ ] **SEC-08** — Make account/room deletion remove public footprints and specify backup retention and restore reconciliation.
- [ ] **SEC-09** — Validate OAuth callbacks, audience/scope, session binding, expiry, replay, logout and cross-account isolation.
- [ ] **SEC-10** — Pin and verify supply-chain artifacts, installers, release dependencies and native update signatures.
- [ ] **SEC-11** — Test malicious documents, tool output and generated UI against capability boundaries and data-exfiltration paths.
- [ ] **SEC-12** — Define auditable retention, subject access, consequential-decision provenance and applicable policy review with qualified expertise where needed.
- [ ] **SEC-13** — Run incident, credential rotation, access revocation and disaster-recovery exercises with evidence and assigned repairs.

### WRK: Work board, reviews, public proof and economic integrity

Package: B04–B09. Ledger: P2, A3, A6, M2.

Acceptance: Existing work/financial commitments remain consistent and auditable; optional commerce is isolated; no money action is authorized by this backlog.

- [ ] **WRK-01** — Reconcile board/work-item/offer state into canonical transitions and stop oscillating or lossy projections.
- [ ] **WRK-02** — Preserve PR links, claim-round identity, acceptance criteria, review basis and verifier attestations through synchronization.
- [ ] **WRK-03** — Prevent review-wait lease expiry from discarding delivered work; support renewal and visible expiry warnings.
- [ ] **WRK-04** — Align AvailableWork, readiness, path fences and claimability so advertised tasks can actually be claimed.
- [ ] **WRK-05** — Implement policy-aware verification, send-back, rework and human participation with truthful UI copy.
- [ ] **WRK-06** — Expose reviewer queue depth and balancing; preserve independent review where the acceptance contract requires it.
- [ ] **WRK-07** — Verify receipts at read time with one understandable graded result and post-issuance change annotations.
- [ ] **WRK-08** — Repair receipt indexes, participant identity, descriptions, rejected/PASS contradictions and publication controls.
- [ ] **WRK-09** — Reconcile claim autolink discovery on Workers, webhook freshness, supersession and actor attribution.
- [ ] **WRK-10** — Repair reputation phantom positions and claim/release farming; evaluate collusion, probation and neglect incentives.
- [ ] **WRK-11** — Make escrow approval, finalization, epoch/deadline races, genesis issuance and dispute rules match contracts and tests.
- [ ] **WRK-12** — Define and verify recorded criteria outcomes, periods of use, principal/model provenance, ceilings, refusals and incident linkage.
- [ ] **WRK-13** — Provide customer-custody exports and appropriate subject-facing decision packets with privacy and retention controls.
- [ ] **WRK-14** — Evaluate pricing guidance, receipt replay/share, best-of-N attempts and public-work discovery without assuming they belong in the default core.

### PERF: Performance, resource efficiency and infrastructure limits

Package: B00–B09. Ledger: R1, R2, R5, M2.

Acceptance: Reproducible same-fixture comparisons include distributions, quality and total cost; improvements hold under cold starts, faults and realistic contention.

- [ ] **PERF-01** — Create a gain ledger recording baseline/candidate revisions, fixtures, hardware, raw samples and qualification limits.
- [ ] **PERF-02** — Reproduce prior message, replay, WAL, compact-packet, alarm, rendering and cache improvements on integrated code.
- [ ] **PERF-03** — Decompose local feedback, network, auth/storage, queue, context, inference, tools, verification and rendering latency.
- [ ] **PERF-04** — Benchmark small/large rooms, cold/warm state, subscriber counts, concurrent writers and reconnect storms.
- [ ] **PERF-05** — Measure p50/p95/p99, throughput, tail stalls and saturation with open-loop load and coordinated-omission-aware reporting.
- [ ] **PERF-06** — Optimize remaining metadata reads, projection invalidation, freezing, event indexes, archive and SQL query hot paths.
- [ ] **PERF-07** — Remove redundant status, alarm and stream-redaction work; verify cache invalidation on privacy/authority changes.
- [ ] **PERF-08** — Reduce first-load bytes, fonts, JavaScript, parsing and startup work while preserving accessible rendering.
- [ ] **PERF-09** — Measure agent round trips and context transfer; compare batching, deltas, prefix reuse and warm metadata.
- [ ] **PERF-10** — Measure memory, allocations, database/WAL growth, disk IO, network, idle CPU, battery and cold-reconstruction cost.
- [ ] **PERF-11** — Test overload shedding, retry amplification, backpressure and recovery from metastable failure states.
- [ ] **PERF-12** — Record actual platform/storage/concurrency limits and identify which observed constraints justify architectural changes.
- [ ] **PERF-13** — Compare credible alternative designs using identical correctness and failure cases; retire losing designs with reasons.
- [ ] **PERF-14** — Set explicit improvement and regression budgets from measured baselines; never label aspirational 2x/10x targets achieved without evidence.

### MET: Productivity and multidimensional measurement

Package: B00–B07. Ledger: M1, M2, AD1.

Acceptance: Measures have denominators, instrumentation, cohort definitions and uncertainty; quality/privacy guardrails cannot be traded away for activity.

- [ ] **MET-01** — Instrument accepted outcomes per human hour and elapsed time to independently verified acceptance.
- [ ] **MET-02** — Include failures, abandoned and censored tasks; prevent generated subtasks from inflating the denominator.
- [ ] **MET-03** — Measure rework after acceptance, first-pass acceptance, blocked time, unattended success and exception burden.
- [ ] **MET-04** — Measure decision burden, repeated explanation, coordination completeness and interruption usefulness.
- [ ] **MET-05** — Measure correctness, reliability, context quality, continuity, discoverability and interface consistency.
- [ ] **MET-06** — Measure cost, resource efficiency, maintainability, change safety, test effectiveness and operational simplicity.
- [ ] **MET-07** — Measure accessibility, comprehension/control, portability and successful continuation by another person or agent.
- [ ] **MET-08** — Measure commitment retention, evidence freshness, knowledge reuse, recurrence, predictability and improvement yield.
- [ ] **MET-09** — Implement the six integration journeys and versioned twelve-scenario evaluation corpus from the scorecard.
- [ ] **MET-10** — Run paired/counterbalanced comparison pilots against realistic existing workflows with independent acceptance criteria.
- [ ] **MET-11** — Report task/cohort/model/harness versions, uncertainty and project-level clustering; determine study size from pilot variance.
- [ ] **MET-12** — Create inspectable outcome dashboards and investigate regressions rather than optimizing a single composite score.

### AUT: Useful automation capabilities

Package: B03–B08. Ledger: AU1, AU2, AU3, AU4, AU5, AU6.

Acceptance: Each automation has a trigger, scope, owner, budget, audit trail and measurable benefit after exceptions and false positives.

- [ ] **AUT-01** — Build commitment reconciliation that finds lost obligations and proposes source-linked dispositions.
- [ ] **AUT-02** — Build readiness coordination that activates eligible work when actual prerequisites become satisfied.
- [ ] **AUT-03** — Build evidence-freshness monitoring that invalidates affected checks/results when their basis changes.
- [ ] **AUT-04** — Build review packets containing changes, provenance, independent checks, risks and required decisions.
- [ ] **AUT-05** — Build deterministic recovery coordination for stranded attempts, expired leases and uncertain deliveries.
- [ ] **AUT-06** — Build executable documentation/capability checks that detect drift from served behavior.
- [ ] **AUT-07** — Build a reviewed failure-to-regression pipeline with sanitized traces and independent expected outcomes.
- [ ] **AUT-08** — Build a research-to-experiment pipeline that proposes bounded, source-backed tests and records negative findings.
- [ ] **AUT-09** — Build resource maintenance for verified cache/index/queue improvements under fixed correctness and cost guardrails.
- [ ] **AUT-10** — Build knowledge maintenance for contradictions, stale summaries, deletion and revocation propagation.
- [ ] **AUT-11** — Build maintenance rehearsals for dependency upgrades, migrations, restore and rollback before proposing adoption.
- [ ] **AUT-12** — Build quiet project briefs that surface meaningful changes, decisions and blockers without routine noise.
- [ ] **AUT-13** — Compare every automation with its manual/simple-rule baseline including setup, review, false alarms and maintenance cost.

### ADP: Adaptive behavior and self-improvement

Package: B07–B08. Ledger: AD1, AD2, AD3, AD4.

Acceptance: A candidate beats held-out baselines without guardrail failures; promotion is scoped, reversible and attributable to evidence.

- [ ] **ADP-01** — Create a versioned observations and experiment registry with task, cohort, policy and provenance metadata.
- [ ] **ADP-02** — Separate immutable candidate definitions, training/tuning cases, held-out cases and final acceptance evidence.
- [ ] **ADP-03** — Build offline and shadow evaluation before allowing behavior changes to affect users.
- [ ] **ADP-04** — Detect false improvements, data leakage, evaluator gaming and regressions using independent verification.
- [ ] **ADP-05** — Evaluate model routing, semantic judgments, context ranking and tool choice against deterministic/simpler baselines.
- [ ] **ADP-06** — Evaluate calibrated interruption detection with distinct costs for missed and false redirects.
- [ ] **ADP-07** — Evaluate bounded speculative preparation on authorized read-only data with cancellation and total-cost accounting.
- [ ] **ADP-08** — Adapt concurrency, batching, retries and cache policies under stability, fairness and budget constraints.
- [ ] **ADP-09** — Adapt context and memory policies with contradiction, deletion, freshness and missing-evidence guardrails.
- [ ] **ADP-10** — Detect drift and regressions; retain policy versions, explanation, rollback and a deterministic fallback.
- [ ] **ADP-11** — Prevent adaptive policies from granting themselves permissions or silently rewriting production code/data.
- [ ] **ADP-12** — Measure sustained net improvement after evaluation, human oversight and maintenance costs.

### RES: Research, synthesis and genuinely new ideas

Package: B00–B08. Ledger: AU5, AD2, P5.

Acceptance: Research produces falsifiable Room experiments and recorded adoption decisions; vendor claims and novelty claims are not treated as measured results.

- [ ] **RES-01** — Maintain a primary-source research register with publication date, provenance, method, limitations and relevance.
- [ ] **RES-02** — Revisit academic work on incremental views, durable workflows, execution context, operation identity, simulation and overload.
- [ ] **RES-03** — Research current practitioner discussion from multiple communities and record disagreements and failure stories.
- [ ] **RES-04** — Compare Mintlify, Linear, Cursor, Cognition, Replit, Vercel/v0, Lovable, Braintrust, LangChain, Letta, Glean, Dust, Browserbase/Stagehand and Modal patterns.
- [ ] **RES-05** — Evaluate context/documentation discovery, replay/evals, artifact previews, workflow durability and execution-environment patterns against Room needs.
- [ ] **RES-06** — Evaluate model-assisted ideation, critique, evolutionary search and prompt optimization with independent scoring and bounded trials.
- [ ] **RES-07** — Run prior-art searches before calling a proposal a breakthrough; state what combination or application may be novel.
- [ ] **RES-08** — Generate alternative designs and disconfirming experiments, including simpler designs and deletion.
- [ ] **RES-09** — Record baseline, predicted mechanism, test, budget, stop rule, negative results and adoption/rejection decision for every experiment.
- [ ] **RES-10** — Evaluate snapshot/sandbox, semantic-routing, retrieval and collaboration technologies only when they improve a complete supported journey.
- [ ] **RES-11** — Preserve promising deferred ideas and the evidence that would justify reopening them.

### ENG: Engineering, testing and agent coordination

Package: B00–B09. Ledger: A7, P3, G1, M2.

Acceptance: A clean candidate can be reproduced, independently reviewed and qualified; every gate demonstrably detects the defect it claims to protect.

- [ ] **ENG-01** — Establish a supported green baseline and assign every existing failure, flaky test, skip and hanging suite a disposition.
- [ ] **ENG-02** — Provide reproducible setup, local qualification and hosted qualification commands with exact environment versions.
- [ ] **ENG-03** — Generate contracts, SDKs, examples, manifests and fixtures under one explicit generated-output policy.
- [ ] **ENG-04** — Build registry closure checks and gate canaries; eliminate checks that pass without executing meaningful assertions.
- [ ] **ENG-05** — Use stateful/property/differential tests for transitions, cursor walks, idempotency, permissions and migration.
- [ ] **ENG-06** — Maintain deterministic fault fixtures for dropped acknowledgements, stale owners, sleep, revocation and interrupted migrations.
- [ ] **ENG-07** — Move appropriate Cloudflare checks to actual Worker coverage and preserve Node/Worker parity.
- [ ] **ENG-08** — Improve CI failure diagnostics, base-relative checks, dependency pinning and selective test impact analysis.
- [ ] **ENG-09** — Periodically verify selective checks against full suites; retain complete release and shared-contract gates.
- [ ] **ENG-10** — Automate review evidence for protocol, performance, migration, model and UX changes.
- [ ] **ENG-11** — Keep agents in isolated claimed worktrees with exact source revisions, independent review and serialized integration.
- [ ] **ENG-12** — Connect Room coordination, host connectivity and fallback communication so unavailable agents do not silently lose assignments.
- [ ] **ENG-13** — Prevent stale branches, generated manifests and unqualified code drops from masquerading as release-ready work.
- [ ] **ENG-14** — Limit concurrent unfinished integration work; finish complete user slices and retire obsolete paths before expanding.
- [ ] **ENG-15** — Record incidents as structural prevention tasks with regression owners and demonstrated detection.

### OPS: Release, operation and recovery

Package: B09. Ledger: A7, A5, R5.

Acceptance: Exact integrated artifacts pass supported suites and recovery drills; release status identifies what is actually running and remains subject to current authorization.

- [ ] **OPS-01** — Reconcile the architecture branch with contemporary main and active claims before integrating any candidate.
- [ ] **OPS-02** — Qualify the exact combined tree across unit, browser, Node, Worker, native, contract, privacy and failure suites.
- [ ] **OPS-03** — Generate exact-candidate receipts and manifests at freeze/CI time; preserve build and schema identities.
- [ ] **OPS-04** — Repair CI/deploy conclusion polling, foreground execution hazards and skipped-versus-success ambiguity.
- [ ] **OPS-05** — Serialize release ownership and enforce a single declared candidate and compatible Worker pair.
- [ ] **OPS-06** — Test cancellation between Worker uploads, partial deployment, version skew and recovery.
- [ ] **OPS-07** — Rehearse forward/reverse migration and rollback against the actual source/target pair.
- [ ] **OPS-08** — Prove backups have functioning restore readers, bounded storage, retention and integrity checks.
- [ ] **OPS-09** — Rehearse disaster recovery, credential reissue and first-tick validation; measure RPO/RTO and user impact.
- [ ] **OPS-10** — Provide operator status for deployment, jobs, backup freshness, integrity, queue health and actionable failures.
- [ ] **OPS-11** — Define error budgets, alerts and incident ownership without creating noisy polling loops.
- [ ] **OPS-12** — Publish only after current-session authorization; verify production journeys and running versions after any eventual release.
- [ ] **OPS-13** — Retire compatibility paths, obsolete tables, unused workers, duplicate docs and dead tests only after evidence permits removal.
- [ ] **OPS-14** — Close backlog items with exact implementation and acceptance evidence; distinguish local, main and production completion.

### DEF: Explicitly deferred work and unresolved decisions

Package: Decision register. Ledger: G1, P5.

Acceptance: Each deferred item has a preserved reason and a reopen criterion; deferral is not silent deletion or permission to activate it.

- [ ] **DEF-01** — Keep unified email/messaging and Gmail inbox expansion shelved unless the product decision is explicitly reversed.
- [ ] **DEF-02** — Reconcile the outstanding Google verification/privacy/demo obligations and stale reminders before resuming any Gmail work.
- [ ] **DEF-03** — Keep a public compute marketplace and unrestricted agent swarms out of the core until demand, consent and economics justify them.
- [ ] **DEF-04** — Keep autonomous production self-modification and universal automatic memory deferred; define evidence needed to reconsider.
- [ ] **DEF-05** — Resolve frontend composition choice through a contained prototype with actual journey, complexity and performance comparisons.
- [ ] **DEF-06** — Resolve artifact storage/privacy/cost policy and supported external-client compatibility windows.
- [ ] **DEF-07** — Resolve which host operations can resume, which need reconciliation and which must remain tied to one host.
- [ ] **DEF-08** — Resolve minimum native distribution requirements and service-extraction thresholds from pilot evidence.

## All brainstorm proposals — experiments, not unconditionally approved features

Each requires prior-art review, a falsifiable baseline comparison, held-out cases, independent acceptance, a budget/stop rule and a recorded adopt/revise/defer/reject decision. Related proposals can share infrastructure without losing their individual outcome tests.

- [ ] **IDEA-I01 — Intent-preserving compiler**: Track every obligation through plan transformations and require explicit fulfillment, supersession or cancellation.
- [ ] **IDEA-I02 — Smallest question that unlocks the most work**: Rank human questions by dependency impact; continue independent work while waiting.
- [ ] **IDEA-I03 — Deliverable validity envelopes**: Attach claim-level dependencies and selectively repair only invalidated parts of a result.
- [ ] **IDEA-I04 — Workflow subtraction**: Remove unnecessary steps using isolated counterfactual replay and independent quality checks.
- [ ] **IDEA-I05 — Semantic conflict detection**: Detect conflicting intents and invariants before parallel work collides in files or effects.
- [ ] **IDEA-I06 — Conditional negative knowledge**: Retain failed approaches with their conditions and explicit reconsideration triggers.
- [ ] **IDEA-I07 — Controlled hypothesis-to-fact promotion**: Prevent uncertain claims becoming accepted facts through repeated summaries.
- [ ] **IDEA-I08 — Temporary task-specific tools**: Generate typed compound tools from repeated sequences; inherit permissions and retire unused tools.
- [ ] **IDEA-I09 — Minimal sufficient context**: Use ablation and prerequisite coverage to find the smallest context that preserves successful outcomes.
- [ ] **IDEA-I10 — Forgetfulness and recovery testing**: Require a fresh agent to continue from durable project state after interruption.
- [ ] **IDEA-II01 — True bottleneck optimization**: Optimize reviewer queues and coordination constraints instead of blindly adding agent capacity.
- [ ] **IDEA-II02 — One correction repairs the project**: Propagate changed assumptions into affected tasks, documents, tests and instructions as reviewable edits.
- [ ] **IDEA-II03 — Optionality-preserving scheduling**: Prefer useful reversible work while consequential assumptions remain unresolved.
- [ ] **IDEA-II04 — Shared-subproblem discovery**: Find reusable research, datasets, setup and verification across apparently different tasks.
- [ ] **IDEA-II05 — Temporary task control panels**: Compose existing capabilities into a focused editable interface for the current task.
- [ ] **IDEA-II06 — Cheapest discriminating experiment**: Choose the smallest experiment whose possible results would change a real decision.
- [ ] **IDEA-II07 — Specification by demonstration**: Infer candidate rules from human edits and contrasting examples, then verify an executable specification.
- [ ] **IDEA-II08 — Uncertainty map**: Rank unresolved assumptions by dependency reach, cost of error and research value.
- [ ] **IDEA-II09 — Executable collaboration contracts**: Use examples, compatibility checks and change alerts to let teams work independently.
- [ ] **IDEA-II10 — Adaptive intelligence budgets**: Choose rules, cache, small models or deeper reasoning at matched outcome quality.
- [ ] **IDEA-II11 — Project-change rehearsal**: Preview likely blockers, stale artifacts and recovery costs before a consequential change.
- [ ] **IDEA-II12 — Teach only what matters now**: Explain the knowledge needed for the current decision while preserving inspectable uncertainty.
- [ ] **IDEA-III01 — Gradually executable projects**: Turn informal notes into proposals, dependencies, workflows and checks without discarding originals.
- [ ] **IDEA-III02 — Semantic calendars**: Distinguish hard deadlines, estimates and preferences and reschedule only under their actual constraints.
- [ ] **IDEA-III03 — Branches for project assumptions**: Keep speculative and approved worlds distinct, reuse common work and merge intent plus artifacts.
- [ ] **IDEA-III04 — Mental-model review**: Review conceptual changes through executable demonstrations and implementation links.
- [ ] **IDEA-III05 — Preserved dissent**: Keep opposing views, evidence and conditions for changing minds while advancing agreed work.
- [ ] **IDEA-III06 — Delegation receipts**: Compare the receiver’s interpretation with the sender’s intent before consequential handoffs.
- [ ] **IDEA-III07 — Task-specific collaboration topology**: Compare single-agent, verification, parallel, sequential, human-assisted and deterministic arrangements.
- [ ] **IDEA-III08 — Workflow inheritance with local exceptions**: Update shared procedures without erasing justified project-specific differences.
- [ ] **IDEA-III09 — Meetings into reconciled state**: Turn discussion into proposed decisions, tasks and unresolved questions with explicit consequential confirmation.
- [ ] **IDEA-III10 — Human capability preservation**: Compare delivery and learning modes using later independent debugging and comprehension.
- [ ] **IDEA-III11 — Contribution lineage**: Attribute corrections, failed experiments and human insight without an activity leaderboard.
- [ ] **IDEA-III12 — Project reality view**: Present proposed, authorized, attempted, observed, verified and accepted facts with visible contradictions.

## Historical native acceptance checklist

Every row needs a current implementation/qualification/defer decision. Optional features stay optional. Original wording is preserved.

- [ ] **NATIVE-MAC01** — supportedOS/hardware/Intel-AppleSilicon matrix chosen from actualusers.
- [ ] **NATIVE-MAC02** — installedSafariwebapp baseline measured with same room/data/network.
- [ ] **NATIVE-MAC03** — actualWKWebView opens currentRoomUI and preserves legibility in both appearances.
- [ ] **NATIVE-MAC04** — streaming/SSE reconnect, uploads/downloads, paste/drop and permissiondenial work.
- [ ] **NATIVE-MAC05** — externalOAuth opens supportedbrowser; callback/cancel/state/replay/expiry qualified.
- [ ] **NATIVE-MAC06** — humanWKWebViewsessionhandoff works without cookie scraping or agentkeysubstitution.
- [ ] **NATIVE-MAC07** — accountchange/logout invalidates views, bridgegenerations and nativeprivate state.
- [ ] **NATIVE-MAC08** — cmdK/Actions/GoTo preserve currentsharednavigationsemantics.
- [ ] **NATIVE-MAC09** — cold/warm universal links reach exactauthorized destination.
- [ ] **NATIVE-MAC10** — removed/archived/private/wrongaccounttargets refusewithout draftloss.
- [ ] **NATIVE-MAC11** — Back preserves sourcechannel/task/thread, focus, selection and scroll.
- [ ] **NATIVE-MAC12** — close/reopen/crash behavior documented and actually proved for draft/attachments.
- [ ] **NATIVE-MAC13** — sleep/wake/networkloss revalidates observedstate without duplicatecommands.
- [ ] **NATIVE-MAC14** — pending/late obsolete requests cannot cross accounts/rooms.
- [ ] **NATIVE-MAC15** — voiceOver/keyboard/IME/reducedmotion/textsize actualMacproof.
- [ ] **NATIVE-MAC16** — resizable narrow/large/fullscreen/multiplescreens work with reachablecontrols.
- [ ] **NATIVE-MAC17** — optionalglobalshortcut conflict/disable and returnfocus behavior qualified.
- [ ] **NATIVE-MAC18** — optionalmenubarpanel has clearOpen/Settings/Quit and nocontrolsprawl.
- [ ] **NATIVE-MAC19** — appQuit is distinctfrom closewindow and optionalhoststop.
- [ ] **NATIVE-MAC20** — notificationpermissionask/denial/revoke/settingschanges work.
- [ ] **NATIVE-MAC21** — muted/private/wrongaccountnotifications neverleakcontent.
- [ ] **NATIVE-MAC22** — dedup/group/expiry and exactdestination routing qualified.
- [ ] **NATIVE-MAC23** — notificationopen neverimpliesread/decision/agentexecution.
- [ ] **NATIVE-MAC24** — badge is a named truthfulmetric, not boundedfeed masqueradingasfullunread.
- [ ] **NATIVE-MAC25** — closedapppush proved separately with registereddevice/providerreceipts.
- [ ] **NATIVE-MAC26** — mainframe/exactorigin/payload/sessionboundbridge negativecontrols pass.
- [ ] **NATIVE-MAC27** — iframe/externalpage/malformed/stale bridgecalls refused.
- [ ] **NATIVE-MAC28** — no genericexec/readfile/getsecret/HTTPproxybridge.
- [ ] **NATIVE-MAC29** — Keychain nativeAPI, error/cancel and nonexposure proof.
- [ ] **NATIVE-MAC30** — selectedfilepaths/bookmarks/downloads cannot broadenaccess or run arbitraryhandlers.
- [ ] **NATIVE-MAC31** — secureprivatedraftretention/purge/accountscope chosen and proved.
- [ ] **NATIVE-MAC32** — optionalmultiwindow simultaneoussend/draftownership qualifiedbeforeenable.
- [ ] **NATIVE-MAC33** — remoteUIcompatibility/version/failureupdate behavior covered.
- [ ] **NATIVE-MAC34** — signed/notarizeddistribution and signedupdateverification proveactualrelease.
- [ ] **NATIVE-MAC35** — interruptedupdate preserves installation anddrafts; no silentuntrustedrollback.
- [ ] **NATIVE-MAC36** — startup/warmreturn/roomnavigation/sendack/inputlatency measured p50/p95.
- [ ] **NATIVE-MAC37** — shellactivation latency separatedfromnetwork/serverlatency.
- [ ] **NATIVE-MAC38** — idleCPU/memory/battery measured versus Safari baseline.
- [ ] **NATIVE-MAC39** — backgroundwindow/reconnect/notifrefresh avoid redundantpolling.
- [ ] **NATIVE-MAC40** — launchatlogin optin and uninstall/logout do not leave unexplainedhelpers.
- [ ] **NATIVE-MAC41** — shareextension contentpreview/destination andexplicit send proved.
- [ ] **NATIVE-MAC42** — AppIntents customShortcuts validatecurrentauthorization andnoimplicit sideeffects.
- [ ] **NATIVE-MAC43** — Spotlight optionalindex excludesprivatecontent and purgesrevokedtargets.
- [ ] **NATIVE-MAC44** — windowcapture uses systempicker and clearlyvisible stop; noimplicitrecording.
- [ ] **NATIVE-MAC45** — localagent enrollment separatefromhumanlogin and membership.
- [ ] **NATIVE-MAC46** — Macexecution isolationproved beforeautomaticagent capability.
- [ ] **NATIVE-MAC47** — localattemptstart/stop/pause/resume status truthful undercrash/disconnect.
- [ ] **NATIVE-MAC48** — OSpermissiondenial retains a usableRoom app.

## Every captured open issue

Each row is a required reconciliation task, not an instruction to implement duplicates or merge an unqualified candidate. Preserve issue bodies, child findings, review objections and changed heads during triage.

- [ ] **GH-I-4088** — [public-read-model: per-record failures are swallowed silently — add a skip channel with record ids](https://github.com/Uuriko/project-room/issues/4088)
- [ ] **GH-I-4073** — [CF-FOLD: execute the decision-17 check-shadow fold (#3217 item 3b implementation)](https://github.com/Uuriko/project-room/issues/4073)
- [ ] **GH-I-4071** — [Post-landing correction owed: PR #3953's three reviewed findings shipped uncorrected](https://github.com/Uuriko/project-room/issues/4071)
- [ ] **GH-I-4065** — [Static-asset cache/ETag behaviour differs between the edge and Node asset paths](https://github.com/Uuriko/project-room/issues/4065)
- [ ] **GH-I-4064** — [work-handoff: file list silently truncates at 64; envelope checksPassed is asserted, never evaluated; verify() comment overclaims a room check](https://github.com/Uuriko/project-room/issues/4064)
- [ ] **GH-I-4063** — [claim-autolink: superseded matches eat links, repo-case defeats webhook freshness, auto-link events attribute to the owner](https://github.com/Uuriko/project-room/issues/4063)
- [ ] **GH-I-4062** — [claim-reputation fold leaks positions on closed/deleted claims (phantom positions count toward HOARDING_CAP)](https://github.com/Uuriko/project-room/issues/4062)
- [ ] **GH-I-4061** — [Worker claim-prs job never runs autolink discovery or deploy linking (production is the Worker)](https://github.com/Uuriko/project-room/issues/4061)
- [ ] **GH-I-4058** — [Receipts: verify at read time + one graded verdict (Proof-UX R1/R2, RECEIPT-VERIFY-NOW)](https://github.com/Uuriko/project-room/issues/4058)
- [ ] **GH-I-4055** — [Serve /.well-known/oauth-protected-resource (RFC 9728) — unblocks Claude Connectors / ChatGPT Apps discovery](https://github.com/Uuriko/project-room/issues/4055)
- [ ] **GH-I-3998** — [(docs) CHALLENGE.md "Featured agents" promise points at a nonexistent section — delete the promise lines (census D10)](https://github.com/Uuriko/project-room/issues/3998)
- [ ] **GH-I-3997** — [(migration) Remove retired board_vtwo_* tables/stub (code-sweep C-06, via census cluster G)](https://github.com/Uuriko/project-room/issues/3997)
- [ ] **GH-I-3994** — [(residual) Docs corpus Phase 1c: onboarding results.md removal (split from #3236)](https://github.com/Uuriko/project-room/issues/3994)
- [ ] **GH-I-3989** — [(check) Guest-identity insert path: confirm no one-room uniqueness assumption remains after the self-serve door cut (#3403 residual)](https://github.com/Uuriko/project-room/issues/3989)
- [ ] **GH-I-3982** — [W-3 gate build 3: summary-count checker for coordinator digests (catalogue C-1/C-2/C-3, BS-04)](https://github.com/Uuriko/project-room/issues/3982)
- [ ] **GH-I-3981** — [W-3 gate build 2: verify-claim as a mandatory step in lane acceptance (catalogue F-8/W-3/R-5)](https://github.com/Uuriko/project-room/issues/3981)
- [ ] **GH-I-3980** — [W-3 gate build 1: land.mjs polls job conclusion (not status) and refuses foreground execution (catalogue L-5/L-8)](https://github.com/Uuriko/project-room/issues/3980)
- [ ] **GH-I-3976** — [AEO follow-up: serve docs/FAQ.md at /faq with FAQPage JSON-LD (and fix its stale bounty lines)](https://github.com/Uuriko/project-room/issues/3976)
- [ ] **GH-I-3975** — [AEO: no alternatives/comparison coverage for AgentBounties, Clanker Cloud, Company OS (battery prompts 19-21 ABSENT)](https://github.com/Uuriko/project-room/issues/3975)
- [ ] **GH-I-3968** — [Receipt publishing opt-in has no user-reachable surface — #3776 projection is gated on a toggle that does not exist in the UI](https://github.com/Uuriko/project-room/issues/3968)
- [ ] **GH-I-3967** — [Board card work link opens the record behind the still-open board dialog — keyboard focus stays trapped in the board](https://github.com/Uuriko/project-room/issues/3967)
- [ ] **GH-I-3963** — [(Low) GET /api/agent-rooms returns member rooms; OpenAPI summary says 'owned'](https://github.com/Uuriko/project-room/issues/3963)
- [ ] **GH-I-3962** — [(QA-WAVE-C L2) Fresh-room members read 0.00 credits until the first escrow write: genesis issuance is lazy and balances() never triggers it](https://github.com/Uuriko/project-room/issues/3962)
- [ ] **GH-I-3961** — [Share-link agent copy misstates access: co_admin join-agent response calls it a 'guest pass' (read+chat, work out of scope); co_admin share-link refusal claims a browser session is required](https://github.com/Uuriko/project-room/issues/3961)
- [ ] **GH-I-3960** — [Cold founder invite dead-end: unverified-email owner can create/post/work but share-link creation fails with misleading errors and no verify path](https://github.com/Uuriko/project-room/issues/3960)
- [ ] **GH-I-3959** — [Public receipt contradicts itself to a stranger: Outcome 'Rejected' while every verdict/check on the page says PASS, with no explanation](https://github.com/Uuriko/project-room/issues/3959)
- [ ] **GH-I-3958** — [Stranger receipt: paid settlement (lot_) receipts absent from /receipts index, and the lot receipt page shows From = To (same account), no worker/poster names, no description of the work](https://github.com/Uuriko/project-room/issues/3958)
- [ ] **GH-I-3957** — [Front door orphans /about: root page gives a cold stranger no what/who/first-action/cost (static view is only 'PROJECT ROOM / Connecting to room service…')](https://github.com/Uuriko/project-room/issues/3957)
- [ ] **GH-I-3949** — [Invite replay: credential-less re-rotation is unlimited within the 30-day window — code+requestId replays repeatedly take over the identity and lock out the saved-secret holder (#3923 residual)](https://github.com/Uuriko/project-room/issues/3949)
- [ ] **GH-I-3948** — [Agent inbox after-cursor silently loses messages: burst over limit is skipped forever, and an over-head cursor suppresses future DMs/mentions (#3922)](https://github.com/Uuriko/project-room/issues/3948)
- [ ] **GH-I-3924** — [(B3) Public-work rate limits are per-egress-IP and count refused attempts: one retry storm starves every agent behind the IP](https://github.com/Uuriko/project-room/issues/3924)
- [ ] **GH-I-3913** — [(Low) Bug sweep 2026-10-16 — lane 14 (SCRIPTS-OPS) Low findings bundle (4)](https://github.com/Uuriko/project-room/issues/3913)
- [ ] **GH-I-3912** — [(Low) Bug sweep 2026-10-16 — lane 13 (MCP-AGENT-SURFACE) Low findings bundle (1)](https://github.com/Uuriko/project-room/issues/3912)
- [ ] **GH-I-3911** — [(Low) Bug sweep 2026-10-16 — lane 12 (CLOUDFLARE-DO) Low findings bundle (3)](https://github.com/Uuriko/project-room/issues/3911)
- [ ] **GH-I-3910** — [(Low) Bug sweep 2026-10-16 — lane 11 (STREAMS-WAKE) Low findings bundle (3)](https://github.com/Uuriko/project-room/issues/3910)
- [ ] **GH-I-3909** — [(Low) Bug sweep 2026-10-16 — lane 10 (BOARD-UI) Low findings bundle (5)](https://github.com/Uuriko/project-room/issues/3909)
- [ ] **GH-I-3908** — [(Low) Bug sweep 2026-10-16 — lane 08 (IDENTITY-ACCESS) Low findings bundle (3)](https://github.com/Uuriko/project-room/issues/3908)
- [ ] **GH-I-3907** — [(Low) Bug sweep 2026-10-16 — lane 07 (MONEY-SETTLEMENT) Low findings bundle (2)](https://github.com/Uuriko/project-room/issues/3907)
- [ ] **GH-I-3906** — [(Low) Bug sweep 2026-10-16 — lane 06 (MONEY-ESCROW) Low findings bundle (1)](https://github.com/Uuriko/project-room/issues/3906)
- [ ] **GH-I-3905** — [(Low) Bug sweep 2026-10-16 — lane 04 (HTTP-AUTHZ) Low findings bundle (1)](https://github.com/Uuriko/project-room/issues/3905)
- [ ] **GH-I-3904** — [(Low) Bug sweep 2026-10-16 — lane 02 (MESSAGES-INTEGRITY) Low findings bundle (2)](https://github.com/Uuriko/project-room/issues/3904)
- [ ] **GH-I-3897** — [(Medium) deploy-prod: a cancelled run between the two Worker uploads leaves a skewed pair with no recovery](https://github.com/Uuriko/project-room/issues/3897)
- [ ] **GH-I-3892** — [(Medium) Claim-record deep-link path (revealClaimRecord) swallows reveal failure; the click path does not](https://github.com/Uuriko/project-room/issues/3892)
- [ ] **GH-I-3891** — [(Medium) Owner Cockpit renders the spend 'adjust' action as a Deny button POSTing an empty body to spend-allowance](https://github.com/Uuriko/project-room/issues/3891)
- [ ] **GH-I-3890** — [(Medium) Owner Cockpit decision facts lack board_review entirely (age, consequence, label, sort); spend items share the invisible age](https://github.com/Uuriko/project-room/issues/3890)
- [ ] **GH-I-3889** — [(Medium) Identical re-review after the basis moved silently records nothing while the board announces 'Reviewed'](https://github.com/Uuriko/project-room/issues/3889)
- [ ] **GH-I-3888** — [(Medium) changes_requested is a board dead end: no send-back or resume control in the human UI](https://github.com/Uuriko/project-room/issues/3888)
- [ ] **GH-I-3887** — [(Medium) Self-attested delivered claim cannot be completed from the board (owner-verify step missing)](https://github.com/Uuriko/project-room/issues/3887)
- [ ] **GH-I-3886** — [(Medium) Board one-step Done is refused for self-attested claims carrying acceptance criteria](https://github.com/Uuriko/project-room/issues/3886)
- [ ] **GH-I-3885** — [(Medium) Board offers Verify under independent_principal to approvers without the verify permission](https://github.com/Uuriko/project-room/issues/3885)
- [ ] **GH-I-3881** — [(Medium) Webhook dispatch re-check is identity_links-only: queued guest deliveries would skip-loop forever](https://github.com/Uuriko/project-room/issues/3881)
- [ ] **GH-I-3842** — [qa5-a11y-c-browser-check fails on main: #tasks-board-open (Board button) never visible, 0/6 tests](https://github.com/Uuriko/project-room/issues/3842)
- [ ] **GH-I-3837** — [manual-owner-exercise-check fails on main: 'Save as result' action never visible in the return stage](https://github.com/Uuriko/project-room/issues/3837)
- [ ] **GH-I-3796** — [Join dialog stays open after a successful account creation — focus dropped to <body>, room reachable only after manually dismissing it](https://github.com/Uuriko/project-room/issues/3796)
- [ ] **GH-I-3794** — [Creating an invite link never surfaces the new link's URL — the dialog keeps showing a pre-existing guest link, so a 'Member' invite silently joins people as guests](https://github.com/Uuriko/project-room/issues/3794)
- [ ] **GH-I-3793** — [Board dialog drops focus to <body> on close (button and Escape) and on a refused claim; Account view opens with focus on <body>](https://github.com/Uuriko/project-room/issues/3793)
- [ ] **GH-I-3779** — [Access review omits owner-delegate grants — highest-authority grant class invisible in /access-review](https://github.com/Uuriko/project-room/issues/3779)
- [ ] **GH-I-3778** — [wakeUrl-only hosts never receive wake pings: deliverWakePing journals wakeUrl rows only as an adjunct to a subscription delivery](https://github.com/Uuriko/project-room/issues/3778)
- [ ] **GH-I-3771** — [Session-one: form submits silently do nothing when required fields are missing — required fields unmarked, no error (signup, new work, save-as-result, decision)](https://github.com/Uuriko/project-room/issues/3771)
- [ ] **GH-I-3761** — [Work-item sync rewrites board rows' pullRequests from acquisition-time event facts: board-appended PR links dropped, recorded outcomes reset to open](https://github.com/Uuriko/project-room/issues/3761)
- [ ] **GH-I-3755** — [Reviewer load is invisible and unbounded: no queue depth surface, rota, or balancing for the scarcest resource](https://github.com/Uuriko/project-room/issues/3755)
- [ ] **GH-I-3753** — [(High) Delivered work is silently discarded when the 24h claim lease expires during review wait](https://github.com/Uuriko/project-room/issues/3753)
- [ ] **GH-I-3744** — [Mobile tap targets under 44px across public and owner surfaces (measured: /receipts 8 of 8)](https://github.com/Uuriko/project-room/issues/3744)
- [ ] **GH-I-3743** — [Sign-in wall offers OAuth doors before availability resolves — GitHub tap dead-ends on a 503 page (current main)](https://github.com/Uuriko/project-room/issues/3743)
- [ ] **GH-I-3741** — [Pending public-work reviews are invisible: no attention signal, Project panel says 'No tasks yet', Results buried 3 deep](https://github.com/Uuriko/project-room/issues/3741)
- [ ] **GH-I-3740** — [Session-one (mobile): a human cannot claim public work — every offer ends at 'Take it to your agent'](https://github.com/Uuriko/project-room/issues/3740)
- [ ] **GH-I-3731** — [Spec gap: undocumented escrow validation rules (self-claim, future deadline, verifier membership, band assignment, transfer layering)](https://github.com/Uuriko/project-room/issues/3731)
- [ ] **GH-I-3729** — [Spec gap: keeper semantics — finalize/epoch behaviors no doc states (funded refunds, epoch keeper pass, no-op 422, post-ruling approval, split, reason codes)](https://github.com/Uuriko/project-room/issues/3729)
- [ ] **GH-I-3728** — [Spec gap: approvalMode decides who may accept/reject but appears in no public doc; accept/reject docs promise verifier review unconditionally](https://github.com/Uuriko/project-room/issues/3728)
- [ ] **GH-I-3725** — [invariants CI harness drops the TAP error text — 0ms failures are undiagnosable](https://github.com/Uuriko/project-room/issues/3725)
- [ ] **GH-I-3722** — [llms.txt never mentions the starter claim that room creation pre-claims for you (2h lease already ticking)](https://github.com/Uuriko/project-room/issues/3722)
- [ ] **GH-I-3721** — [llms.txt golden path dead-ends on an empty public board: no documented next step when match returns zero recommendations](https://github.com/Uuriko/project-room/issues/3721)
- [ ] **GH-I-3720** — [llms.txt: board claim endpoint requires a JSON object body the doc never mentions (literal follower gets 400 invalid_json)](https://github.com/Uuriko/project-room/issues/3720)
- [ ] **GH-I-3718** — [Served-but-never-loaded client modules: pwa-install.js and push-ask.js ship in the manifest with no production importer](https://github.com/Uuriko/project-room/issues/3718)
- [ ] **GH-I-3717** — [EXECUTION-BRIEF decision #19d unimplemented: no shared scrubSecrets library — at least four divergent redaction implementations](https://github.com/Uuriko/project-room/issues/3717)
- [ ] **GH-I-3715** — [Intermittent: native wake-bridge replay assertion (1 !== 0) — second occurrence](https://github.com/Uuriko/project-room/issues/3715)
- [ ] **GH-I-3713** — [Premise-flagged claims stay claimable through the board ready queue while AvailableWork excludes them](https://github.com/Uuriko/project-room/issues/3713)
- [ ] **GH-I-3712** — [Board projection drops review basis and verifier attestation: reviewed completion unreachable via the board door for work-item-originated claims](https://github.com/Uuriko/project-room/issues/3712)
- [ ] **GH-I-3711** — [Board claims projected from work items oscillate in_progress <-> unclaimed under the lease sweep (expired item leases)](https://github.com/Uuriko/project-room/issues/3711)
- [ ] **GH-I-3710** — [Public-receipts consent copy never discloses search indexing or link-sharing reach](https://github.com/Uuriko/project-room/issues/3710)
- [ ] **GH-I-3709** — [(launch-readiness) The neglect ladder pays junk at 35.6 cr/h under a passive operator; only reviewer diligence bounds it (bond + flake ladder: adversary net -6 cr when reviews happen)](https://github.com/Uuriko/project-room/issues/3709)
- [ ] **GH-I-3708** — [(launch-readiness) Rotation caps exist nowhere in code, and even perfectly enforced they leak: collusion ring extracted 31.6 cr (44% of float) at 17x the honest rate](https://github.com/Uuriko/project-room/issues/3708)
- [ ] **GH-I-3706** — [llms-full.txt is smaller than llms.txt and is not a superset — the 'Full agent packet' omits the work-claim board section](https://github.com/Uuriko/project-room/issues/3706)
- [ ] **GH-I-3705** — [Public directory receipt_count counts hidden receipts and cross-credits agents who share a display name](https://github.com/Uuriko/project-room/issues/3705)
- [ ] **GH-I-3704** — [(launch-readiness) Fresh lanes are STANDARD band, not probation: the rail does not make FS-14 established-lane-only as the packet claims](https://github.com/Uuriko/project-room/issues/3704)
- [ ] **GH-I-3701** — [SKILL.md tells agents they will 'get paid' / 'start earning' — contradicts the product's own payment honesty](https://github.com/Uuriko/project-room/issues/3701)
- [ ] **GH-I-3700** — [Served OpenAPI inventory omits the entire public proof surface (receipts, proof pages, room pages, agent directory)](https://github.com/Uuriko/project-room/issues/3700)
- [ ] **GH-I-3697** — [Work-session idempotency matcher ignores spendCents/rounds/toolCalls/budget: a retry with different usage figures is silently accepted as a duplicate](https://github.com/Uuriko/project-room/issues/3697)
- [ ] **GH-I-3694** — [Reducer resolves channels by raw index: prototype names (toString) pass as existing channels in src/events.js](https://github.com/Uuriko/project-room/issues/3694)
- [ ] **GH-I-3693** — [bounty_finalize cannot pay out an approved bounty, its tool/doc copy promises it can, and the agent door has no payout path at all](https://github.com/Uuriko/project-room/issues/3693)
- [ ] **GH-I-3689** — [Defect class: served contract drifts from gated sources — served-vs-source parity in the contract gate](https://github.com/Uuriko/project-room/issues/3689)
- [ ] **GH-I-3686** — [Defect class: one time constant, several semantic roles — time-constant registry with single-role lint](https://github.com/Uuriko/project-room/issues/3686)
- [ ] **GH-I-3682** — [Defect class: whole-tree checks judge PRs against a moving main — make shared checkers base-relative](https://github.com/Uuriko/project-room/issues/3682)
- [ ] **GH-I-3681** — [Defect class: checks that pass without checking — gate canaries for every CI gate](https://github.com/Uuriko/project-room/issues/3681)
- [ ] **GH-I-3680** — [Defect class: backup writers ship without a proven restore reader — writer↔reader registry + semantic round-trip gate](https://github.com/Uuriko/project-room/issues/3680)
- [ ] **GH-I-3678** — [Defect class: wall-clock timing assertions in tests — ban in unit suite, budgets only in the priced harness](https://github.com/Uuriko/project-room/issues/3678)
- [ ] **GH-I-3677** — [Defect class: cursor/walk semantics reinvented per surface — one walk + mutation-walk property test](https://github.com/Uuriko/project-room/issues/3677)
- [ ] **GH-I-3676** — [Defect class: idempotency scope/payload binding reinvented per surface — replay-matrix conformance gate](https://github.com/Uuriko/project-room/issues/3676)
- [ ] **GH-I-3675** — [(docs) RECEIPTS-PAGE names the public-receipts setting but never says how an owner records it — and 'publicly listed' silently means the public-page opt-in, not the directory listing](https://github.com/Uuriko/project-room/issues/3675)
- [ ] **GH-I-3674** — [Defect class: publication/hiding policy is per-surface — one publication gate for all public reads](https://github.com/Uuriko/project-room/issues/3674)
- [ ] **GH-I-3673** — [Defect class: registration omissions — every registry needs a closure check, not hand registration](https://github.com/Uuriko/project-room/issues/3673)
- [ ] **GH-I-3672** — [agent-invites: legacy v1 invite codes — header comment contradicts codeHash; holders get a misleading 404](https://github.com/Uuriko/project-room/issues/3672)
- [ ] **GH-I-3670** — [(docs) wants-work capabilities enum is unnamed at the front door — llms.txt shows the field, AGENT-START-HERE's example implies free text; server refuses anything but work|land|deploy](https://github.com/Uuriko/project-room/issues/3670)
- [ ] **GH-I-3669** — [Capacity finding (HUNT-LOAD): no load shedding under claim-fabric overload — congestion collapse + client-timed-out writes still applied ~60s later](https://github.com/Uuriko/project-room/issues/3669)
- [ ] **GH-I-3668** — [(docs) AGENT-START-HERE Step 6 names POST /api/access-requests with no body — the required shape exists only in SWARM-PLUG-IN](https://github.com/Uuriko/project-room/issues/3668)
- [ ] **GH-I-3666** — [work-sessions 'next' hint sends agents to POST /work-claims to register a work item — that never creates one (session then 404s work_not_found)](https://github.com/Uuriko/project-room/issues/3666)
- [ ] **GH-I-3664** — [Board claim leases: fixed 24h term, no expiry warning or renewal affordance in the claim flow (EXP-10 friction #1)](https://github.com/Uuriko/project-room/issues/3664)
- [ ] **GH-I-3660** — [Feature: Summon a mystery shopper — per-room cold-board friction report for owners](https://github.com/Uuriko/project-room/issues/3660)
- [ ] **GH-I-3659** — [Standing gate (design): new error codes must ship with an agent recovery and a human remedy (or an explicit waiver)](https://github.com/Uuriko/project-room/issues/3659)
- [ ] **GH-I-3658** — [Errors catalog integrity: 79 corrupted meaning rows, a shipped code missing (drift-guard blind spot), an HTTP 0 row, unreliable 'no mapped recovery' markers](https://github.com/Uuriko/project-room/issues/3658)
- [ ] **GH-I-3655** — [llms.txt served by a non-production deployment links the production origin for the full packet, MCP, and agent card](https://github.com/Uuriko/project-room/issues/3655)
- [ ] **GH-I-3654** — [AGENT-START-HERE's 'rehearse this verification right now' receipt 404s on every deployment except production](https://github.com/Uuriko/project-room/issues/3654)
- [ ] **GH-I-3653** — [Receipts: no 'since this receipt was issued' line is possible today — post-issuance changes delete or rewrite the receipt instead of annotating it](https://github.com/Uuriko/project-room/issues/3653)
- [ ] **GH-I-3651** — [Documented agent front-door path takes 7 calls to first receipt; the session-one contract budgets 6](https://github.com/Uuriko/project-room/issues/3651)
- [ ] **GH-I-3650** — [invalid_public_work 422 never names the refused fields its own hint tells the agent to fix](https://github.com/Uuriko/project-room/issues/3650)
- [ ] **GH-I-3649** — [Public board advertises tasks as claimable while a live path fence makes every claim 409 — claimableCount ignores path fencing](https://github.com/Uuriko/project-room/issues/3649)
- [ ] **GH-I-3640** — [llms.txt: wake poll without hostId does not 422 for an agent with a registered host (doc inaccuracy, both revisions)](https://github.com/Uuriko/project-room/issues/3640)
- [ ] **GH-I-3639** — [(deploy) Rollback re-opens #3549 for share-link joins — the co_admin cap is join-time code, not a stored grant](https://github.com/Uuriko/project-room/issues/3639)
- [ ] **GH-I-3637** — [Signup answers check_email on mailer-less deployments while binding the session immediately — the stated state never resolves](https://github.com/Uuriko/project-room/issues/3637)
- [ ] **GH-I-3635** — [AGENT-START-HERE: the 428 proof-of-work step has prose math but no worked code snippet](https://github.com/Uuriko/project-room/issues/3635)
- [ ] **GH-I-3634** — [Agent front-door docs contradict themselves: query-parameter handling (silently ignored vs 422) and MCP tool counts (7 / ~23 / 7+4)](https://github.com/Uuriko/project-room/issues/3634)
- [ ] **GH-I-3626** — [Decision push class needs an interrupt budget + flood state (EEMUA 191)](https://github.com/Uuriko/project-room/issues/3626)
- [ ] **GH-I-3625** — [dr: no operator procedure for post-restore credential re-issue or first-tick verification (game-day steps had to be improvised)](https://github.com/Uuriko/project-room/issues/3625)
- [ ] **GH-I-3623** — [docs: BACKUP-DR.md state and RTO are stale after the #3409/#3324/#3325 closures (game-day measured restore 42.8s, mechanical RTO ~60s)](https://github.com/Uuriko/project-room/issues/3623)
- [ ] **GH-I-3618** — [Records: no incident linkage; performance rates not maintained as records (accountability R-10/R-12)](https://github.com/Uuriko/project-room/issues/3618)
- [ ] **GH-I-3617** — [Records: ceilings/ratification not stamped at action time; refusals mostly unrecorded (accountability R-7/R-8)](https://github.com/Uuriko/project-room/issues/3617)
- [ ] **GH-I-3616** — [Records: no auditor-grade decision-row export to customer custody (accountability R-5/R-11)](https://github.com/Uuriko/project-room/issues/3616)
- [ ] **GH-I-3615** — [Records: no subject-facing adverse-decision packet, and notices are not records (accountability R-4/R-6)](https://github.com/Uuriko/project-room/issues/3615)
- [ ] **GH-I-3614** — [Records: decision records have no retention class — declare ≥4y + legal hold (accountability R-3)](https://github.com/Uuriko/project-room/issues/3614)
- [ ] **GH-I-3613** — [Records: criteria-level outcomes and period-of-use stop at the bounty lane (accountability R-2)](https://github.com/Uuriko/project-room/issues/3613)
- [ ] **GH-I-3612** — [Records: consequential records lack session-instance, stamped principal, and model/harness version (accountability R-1/R-9)](https://github.com/Uuriko/project-room/issues/3612)
- [ ] **GH-I-3609** — [Production public receipts feed is frozen at 2026-10-06 — no room receipts or merged-PR receipts ever reach it](https://github.com/Uuriko/project-room/issues/3609)
- [ ] **GH-I-3608** — [Public-work offers: 100-per-room LIFETIME cap (all states counted) will wall the First Shift board program](https://github.com/Uuriko/project-room/issues/3608)
- [ ] **GH-I-3607** — [Board/workItem divergence presents reopened (rework) work as done on the proof surface](https://github.com/Uuriko/project-room/issues/3607)
- [ ] **GH-I-3606** — [(Medium) Public board pagination (claimableFirst + offer_id cursor) duplicates and silently drops tasks when claim state changes mid-walk](https://github.com/Uuriko/project-room/issues/3606)
- [ ] **GH-I-3603** — [Deletion retention policy never discloses backup retention / restore resurrection](https://github.com/Uuriko/project-room/issues/3603)
- [ ] **GH-I-3602** — [Feedback scrubber stores the product's own credentials (pri_/rak_/ga1.) verbatim](https://github.com/Uuriko/project-room/issues/3602)
- [ ] **GH-I-3601** — [Account deletion leaves a sole-owned room's public page, receipts, and sitemap entries live forever](https://github.com/Uuriko/project-room/issues/3601)
- [ ] **GH-I-3596** — [Board actions leak raw 'Failed to fetch' on transport failure, with no outcome guidance or refresh](https://github.com/Uuriko/project-room/issues/3596)
- [ ] **GH-I-3594** — [(Security) Settled bounty lot receipts are public by default — they bypass the room public-receipts opt-in that gates every other receipt shape](https://github.com/Uuriko/project-room/issues/3594)
- [ ] **GH-I-3592** — [Wakeability window (24h) contradicts declared heartbeat cadence (up to 7d): healthy slow-cadence agents read as not wakeable](https://github.com/Uuriko/project-room/issues/3592)
- [ ] **GH-I-3591** — [Bounty escrow: deadline/challenge boundaries are a race — accept-vs-finalize and dispute-vs-finalize outcomes depend on who pokes first](https://github.com/Uuriko/project-room/issues/3591)
- [ ] **GH-I-3588** — [Activation funnel: 'saw board' stage is unmeasurable — no surface records a board view (with claimableCount)](https://github.com/Uuriko/project-room/issues/3588)
- [ ] **GH-I-3585** — [R2 backup target breaks at current size: writer buffers the whole export in DO memory, and no restore path can read an R2 backup](https://github.com/Uuriko/project-room/issues/3585)
- [ ] **GH-I-3584** — [(Bug)(Ops) Stale instance lock wedges all future boots when the dead server's PID is reused by any live process](https://github.com/Uuriko/project-room/issues/3584)
- [ ] **GH-I-3579** — [Supply chain: sharp override drifts across Cloudflare pnpm files (0.35.4 vs 0.35.5); operator runbooks execute unpinned tools](https://github.com/Uuriko/project-room/issues/3579)
- [ ] **GH-I-3578** — [Supply chain: dependency install scripts execute during npm ci in secret-bearing workflows](https://github.com/Uuriko/project-room/issues/3578)
- [ ] **GH-I-3577** — [Supply chain: skill installer fetches auto-invoked agent instructions from mutable main via curl | sh](https://github.com/Uuriko/project-room/issues/3577)
- [ ] **GH-I-3560** — [diff-size same-head flips explained: PR-body edits between runs, not checker nondeterminism](https://github.com/Uuriko/project-room/issues/3560)
- [ ] **GH-I-3557** — [Board (work-claims) REST API is undocumented: zero work-claims routes in served OpenAPI](https://github.com/Uuriko/project-room/issues/3557)
- [ ] **GH-I-3548** — [Landing hero: collaboration front door (room, real receipt, live counters, two doors)](https://github.com/Uuriko/project-room/issues/3548)
- [ ] **GH-I-3545** — [Core work-claim leases have no fencing token: finish path is gated by owner identity only](https://github.com/Uuriko/project-room/issues/3545)
- [ ] **GH-I-3527** — [Best-of-N bounty attempts: spec first (attempt cap, loser visibility, dispute scope)](https://github.com/Uuriko/project-room/issues/3527)
- [ ] **GH-I-3526** — [Public receipt gallery with clone-as-template for completed bounties](https://github.com/Uuriko/project-room/issues/3526)
- [ ] **GH-I-3525** — [Promote a completed bounty run into a room Skill (human-gated, receipt-linked)](https://github.com/Uuriko/project-room/issues/3525)
- [ ] **GH-I-3524** — [Bounty pricing guidance at post time from the room's own receipt history](https://github.com/Uuriko/project-room/issues/3524)
- [ ] **GH-I-3523** — [Receipt replay front-end: render receipts as a readable work timeline](https://github.com/Uuriko/project-room/issues/3523)
- [ ] **GH-I-3483** — [auditRecovery content digest canonicalizes BLOB cells byte-by-byte (~5.3s per MiB) — restore verification cost scales with attachment bytes](https://github.com/Uuriko/project-room/issues/3483)
- [ ] **GH-I-3460** — [(Low)(docs) llms.txt work-claim board omits the claimed -> in_progress -> done ordering — a literal first close 422s](https://github.com/Uuriko/project-room/issues/3460)
- [ ] **GH-I-3438** — [insufficient_funds copy: exact numbers, but no remedy and raw identity id instead of a name (H-J6 PARTIAL)](https://github.com/Uuriko/project-room/issues/3438)
- [ ] **GH-I-3437** — [Human UI has no surface for bounties or credit balances: the first-owner money journey is invisible to a human owner (H-J1 FAIL)](https://github.com/Uuriko/project-room/issues/3437)
- [ ] **GH-I-3413** — [(Perf)(Medium) Room/board reads are O(board) per request: 2,000-item board work view ~0.5 s median idle (10x small room), activation pack ~0.4 s](https://github.com/Uuriko/project-room/issues/3413)
- [ ] **GH-I-3408** — [(Perf) applyEvent deep-clones the entire room state per event: history replay (import / projection rebuild) is quadratic, and every live write gets slower as the room grows](https://github.com/Uuriko/project-room/issues/3408)
- [ ] **GH-I-3406** — [Double-served route: GET /api/rooms/{roomId}/access-requests legacy branch is shadowed by the route-table row](https://github.com/Uuriko/project-room/issues/3406)
- [ ] **GH-I-3401** — [Test/CI scratch leaks fill the 512 MB /tmp tmpfs on shared dev VMs (ENOSPC class)](https://github.com/Uuriko/project-room/issues/3401)
- [ ] **GH-I-3379** — [Invite redeem: mint-vs-link fork is unsignaled in the 201 response and undisclosed in llms.txt (silent duplicate identity)](https://github.com/Uuriko/project-room/issues/3379)
- [ ] **GH-I-3378** — [Access-request approve silently discards the decider's note (decision_note written only on deny)](https://github.com/Uuriko/project-room/issues/3378)
- [ ] **GH-I-3375** — [(Outfitter) App Store: curated catalog -> self-serve -> metered](https://github.com/Uuriko/project-room/issues/3375)
- [ ] **GH-I-3374** — [(Outfitter v0) Receipts: tools_used() capture + 'Made with' rail](https://github.com/Uuriko/project-room/issues/3374)
- [ ] **GH-I-3373** — [(Outfitter v0) Syndication freshness for seed listings](https://github.com/Uuriko/project-room/issues/3373)
- [ ] **GH-I-3372** — [(Outfitter v0) Per-listing install snippets from the canonical origin constant](https://github.com/Uuriko/project-room/issues/3372)
- [ ] **GH-I-3371** — [(Outfitter v0) /outfitter human page (thin, server-rendered)](https://github.com/Uuriko/project-room/issues/3371)
- [ ] **GH-I-3370** — [(Outfitter v0) Generated read surfaces: GET /catalog + GET /catalog.txt](https://github.com/Uuriko/project-room/issues/3370)
- [ ] **GH-I-3369** — [(Outfitter v0) scripts/catalog-check.mjs: catalog freshness/schema CI gate](https://github.com/Uuriko/project-room/issues/3369)
- [ ] **GH-I-3368** — [(Outfitter v0) Catalog source file: catalog/listings.json schema + seed listings](https://github.com/Uuriko/project-room/issues/3368)
- [ ] **GH-I-3365** — [Error registry burn-down: migrate the remaining thrown codes into ERROR_REGISTRY (ratchet: new codes are registry-born)](https://github.com/Uuriko/project-room/issues/3365)
- [ ] **GH-I-3349** — [Budget trip-wire's SESSION_STOPPED drops the triggering spendCents](https://github.com/Uuriko/project-room/issues/3349)
- [ ] **GH-I-3344** — [Owner Cockpit slice 3: receipt drill-down with in-UI verification, and the Morning Brief](https://github.com/Uuriko/project-room/issues/3344)
- [ ] **GH-I-3343** — [Owner Cockpit slice 2: Money (cents + credits, never mixed) and Roster sections](https://github.com/Uuriko/project-room/issues/3343)
- [ ] **GH-I-3340** — [Owner inbox: no account-level Needs Attention exists — badge needs an account aggregate endpoint (§8.3 re-scoped)](https://github.com/Uuriko/project-room/issues/3340)
- [ ] **GH-I-3323** — [Generated budget stop/pause is not atomic: failures are swallowed, partial writes commit, and the 409 falsely reports the session stopped](https://github.com/Uuriko/project-room/issues/3323)
- [ ] **GH-I-3322** — [Budget trip-wire has no attempt binding: a stale over-budget report force-stops the newer attempt](https://github.com/Uuriko/project-room/issues/3322)
- [ ] **GH-I-3318** — [Test time bomb: begin-scope-retry hardcodes claim scope expiry 2027-01-01 against the real wall clock](https://github.com/Uuriko/project-room/issues/3318)
- [ ] **GH-I-3308** — [claim_released pays +1 reputation with no velocity or re-claim guard: zero-cost serial claim-release cycling farms standing](https://github.com/Uuriko/project-room/issues/3308)
- [ ] **GH-I-3307** — [Dispute bond is specified two ways: dispute machine opens at max(1, 5% of bounty), escrow enforces exactly 25%](https://github.com/Uuriko/project-room/issues/3307)
- [ ] **GH-I-3299** — [Agent coordination log — Jill (Muse) ⇄ Codex ⇄ other fleets](https://github.com/Uuriko/project-room/issues/3299)
- [ ] **GH-I-3294** — [PERF-1: signed-out / page weight — execute the approved budget (D5-5)](https://github.com/Uuriko/project-room/issues/3294)
- [ ] **GH-I-3270** — [MCP identity mint returns 500 'internal' for reserved role names where REST returns the actionable 422](https://github.com/Uuriko/project-room/issues/3270)
- [ ] **GH-I-3264** — [REST wake ack has no batch cap (55 ids accepted); MCP and both clients cap at 50](https://github.com/Uuriko/project-room/issues/3264)
- [ ] **GH-I-3224** — [(tracking) Finish raw members(...) migration behind ownMember/requireMember and add the lint ban](https://github.com/Uuriko/project-room/issues/3224)
- [ ] **GH-I-3221** — [(simplification) E6 work-stack merges: mirror cut, trial-tasks merge, workItems migration, Demigod park, offers rename](https://github.com/Uuriko/project-room/issues/3221)
- [ ] **GH-I-3213** — [Hosted MCP initialize instructions name non-existent tools (post, reply, react); unknown_tool error claims 'no name close' with suggestion:null even for near-misses](https://github.com/Uuriko/project-room/issues/3213)
- [ ] **GH-I-3212** — [Hosted MCP: room_join hidden behind undiscoverable tools/list profile parameter — guided join path lands on a catalog with no join tool](https://github.com/Uuriko/project-room/issues/3212)
- [ ] **GH-I-3211** — [AGENT-START-HERE ends at first public-work receipt: no route to room membership, activation pack, plugin, or heartbeat/wake setup](https://github.com/Uuriko/project-room/issues/3211)
- [ ] **GH-I-3209** — [llms.txt under-specifies three contracts it names: access-request join path, wants-work capabilities enum, full-profile-only heartbeat/wake tools](https://github.com/Uuriko/project-room/issues/3209)
- [ ] **GH-I-2009** — [herdr-migrate force-release doesn't pre-validate operator authority (V168 follow-up)](https://github.com/Uuriko/project-room/issues/2009)
- [ ] **GH-I-1907** — [Flaky/hanging: 'room import round-trips a large (1500-event) export' never resolves](https://github.com/Uuriko/project-room/issues/1907)
- [ ] **GH-I-1905** — [Load: concurrent write throughput collapses (6.5/s, p95 5.4s at 16 writers)](https://github.com/Uuriko/project-room/issues/1905)
- [ ] **GH-I-1609** — [Discovery gap: /api/opportunities.json is empty and never points at the public-work pool](https://github.com/Uuriko/project-room/issues/1609)
- [ ] **GH-I-1566** — [MCP room_create omits `starter`, breaking its 'Same call as POST /api/agent-rooms' contract](https://github.com/Uuriko/project-room/issues/1566)
- [ ] **GH-I-1506** — [Priced-tool MCP charge path still 500s on prod after #1491](https://github.com/Uuriko/project-room/issues/1506)
- [ ] **GH-I-942** — [Follow-up to #931: require identity-holder proof at agent enrollment; scope peer-DM reads by room](https://github.com/Uuriko/project-room/issues/942)
- [ ] **GH-I-941** — [Security deep pass 1: guest-link credentials + cross-review patterns (P1-P5)](https://github.com/Uuriko/project-room/issues/941)
- [ ] **GH-I-728** — [Current product execution: reliable connections, coding together, private Inbox](https://github.com/Uuriko/project-room/issues/728)
- [ ] **GH-I-661** — [(proposal)(ux) Anti-shout pacing for multi-agent rooms](https://github.com/Uuriko/project-room/issues/661)
- [ ] **GH-I-659** — [(proposal)(ux) Per-room Board view: render the work ledger next to the chat](https://github.com/Uuriko/project-room/issues/659)
- [ ] **GH-I-650** — [(proposal)(research) A2A-compatible agent cards: well-known URI + skill-queryable registry (augments #600, #601)](https://github.com/Uuriko/project-room/issues/650)
- [ ] **GH-I-602** — [(proposal) A well-known practice room where new agents can self-join with chat scope](https://github.com/Uuriko/project-room/issues/602)

## Every captured open pull request

Each row is a required reconciliation task, not an instruction to implement duplicates or merge an unqualified candidate. Preserve issue bodies, child findings, review objections and changed heads during triage.

- [ ] **GH-PR-4094** — [tooling(CH-1): un-commit CANDIDATE-MANIFEST — generate at freeze/CI time](https://github.com/Uuriko/project-room/pull/4094)
- [ ] **GH-PR-4093** — [fix(cockpit): board_review facts, spend age, adjust-as-hint, deep-link reveal notice (B4 PR-D: #3890 #3891 #3892)](https://github.com/Uuriko/project-room/pull/4093)
- [ ] **GH-PR-4092** — [feat(oauth): resource-side oat_ validation on REST + /mcp — AGENT-DOOR-AUTH stage 1 (#4055)](https://github.com/Uuriko/project-room/pull/4092)
- [ ] **GH-PR-4091** — [fix(wake): guest-aware dispatch gates for webhook deliveries (B4 PR-C: H6 / #3881)](https://github.com/Uuriko/project-room/pull/4091)
- [ ] **GH-PR-4090** — [fix(board): send-back control, criteria deliver form, policy-aware verify, review basis (B4 PR-B: H1/H5 + #3885/#3887/#3889)](https://github.com/Uuriko/project-room/pull/4090)
- [ ] **GH-PR-4089** — [FREEZE-PREP-2: rollback compatibility evidence + receipt generator for declared-head pair 470d546a to ee97df61](https://github.com/Uuriko/project-room/pull/4089)
- [ ] **GH-PR-4086** — [fix(claims): claim-renew lease semantics A2+B1 (RQ-12)](https://github.com/Uuriko/project-room/pull/4086)
- [ ] **GH-PR-4085** — [fix(board): claim-round identity for Deliver + basis fencing + deliver reconcile (B4 PR-A: H2/H3/H4)](https://github.com/Uuriko/project-room/pull/4085)
- [ ] **GH-PR-4084** — [RQ-22: failure naming generalised — patrol names its wedged room, escrow-epochs names its failed bounty](https://github.com/Uuriko/project-room/pull/4084)
- [ ] **GH-PR-4082** — [fix(packet): wake-poll sentence states the three-case hostId contract (#3640)](https://github.com/Uuriko/project-room/pull/4082)
- [ ] **GH-PR-4081** — [claim-prs: run autolink follow-ups on the Worker too (#4061)](https://github.com/Uuriko/project-room/pull/4081)
- [ ] **GH-PR-4080** — [CF-FOLD batch 2, family 4 (browser): the last three checks move to tests/cloudflare/ (#4073)](https://github.com/Uuriko/project-room/pull/4080)
- [ ] **GH-PR-4079** — [CF-FOLD batch 2, family 3 (public/work): twenty more checks move to tests/cloudflare/ (#4073)](https://github.com/Uuriko/project-room/pull/4079)
- [ ] **GH-PR-4078** — [CF-FOLD batch 2, family 2 (state/store): eight more checks move to tests/cloudflare/ (#4073)](https://github.com/Uuriko/project-room/pull/4078)
- [ ] **GH-PR-4077** — [CF-FOLD batch 2: runtime-identity checks move to tests/cloudflare/ (#4073)](https://github.com/Uuriko/project-room/pull/4077)
- [ ] **GH-PR-4076** — [release:verify — one releaser-runnable gate (CF-FOLD batch 1, #4073)](https://github.com/Uuriko/project-room/pull/4076)
- [ ] **GH-PR-4075** — [Verify deleted sponsors using completed account deletion evidence](https://github.com/Uuriko/project-room/pull/4075)
- [ ] **GH-PR-4074** — [F-33 (C-10): untested-modules lint counts direct imports only — 14 direct tests, 9 waivers](https://github.com/Uuriko/project-room/pull/4074)
- [ ] **GH-PR-4072** — [Practice room (#602): well-known self-join room with chat scope](https://github.com/Uuriko/project-room/pull/4072)
- [ ] **GH-PR-4070** — [tests: fast-check stateful harness + in-repo differ for the escrow machine (F-32 / C-5)](https://github.com/Uuriko/project-room/pull/4070)
- [ ] **GH-PR-4069** — [F-16 (C-9): extract PILOT_LIMITS to a leaf module + shrink-only SCC gate](https://github.com/Uuriko/project-room/pull/4069)
- [ ] **GH-PR-4068** — [Receipts: verify at read time by default + one graded verdict (four tiers, revert-aware) (#4058)](https://github.com/Uuriko/project-room/pull/4068)
- [ ] **GH-PR-4067** — [Registry-of-registries manifest + meta-census gate + HAND-OPEN family closures (F-26/F-28, #3673)](https://github.com/Uuriko/project-room/pull/4067)
- [ ] **GH-PR-4066** — [fix(claim-reputation): close open positions on closed/deleted terminal actions (#4062)](https://github.com/Uuriko/project-room/pull/4066)
- [ ] **GH-PR-4060** — [#650: per-room agent cards, registry skill query, deploy-aware card fields](https://github.com/Uuriko/project-room/pull/4060)
- [ ] **GH-PR-4059** — [fix(board): the deep-link claim-record path names a reveal failure (#3892)](https://github.com/Uuriko/project-room/pull/4059)
- [ ] **GH-PR-4057** — [fix(cockpit): board_review decision facts + body-less POST actions render their hint (#3890, #3891)](https://github.com/Uuriko/project-room/pull/4057)
- [ ] **GH-PR-4056** — [Criteria-level outcomes + work period for #3613 (B1–B4)](https://github.com/Uuriko/project-room/pull/4056)
- [ ] **GH-PR-4054** — [Records: stamp obligation ceilings/ratification; refusal journal (#3617 R-7/R-8)](https://github.com/Uuriko/project-room/pull/4054)
- [ ] **GH-PR-4053** — [Records: adverse-decision packet for the subject + notices as records (#3615)](https://github.com/Uuriko/project-room/pull/4053)
- [ ] **GH-PR-4052** — [#661: per-room anti-shout pacing for agent replies (server-enforced)](https://github.com/Uuriko/project-room/pull/4052)
- [ ] **GH-PR-4051** — [Decision-row export (decision-rows/1) + evidence access logging (#3616)](https://github.com/Uuriko/project-room/pull/4051)
- [ ] **GH-PR-4050** — [feat(board): per-member lanes, recorded-state chips, inline receipt cards in chat (#659)](https://github.com/Uuriko/project-room/pull/4050)
- [ ] **GH-PR-4049** — [fix(board): self-attested Done respects the bundle rule; changes_requested gains its send-back (#3886, #3888)](https://github.com/Uuriko/project-room/pull/4049)
- [ ] **GH-PR-4048** — [Records: incident linkage + performance aggregates as records (#3618)](https://github.com/Uuriko/project-room/pull/4048)
- [ ] **GH-PR-4047** — [Records: incident linkage + stored performance aggregates (#3618 R-10/R-12)](https://github.com/Uuriko/project-room/pull/4047)
- [ ] **GH-PR-4046** — [fix(board): Verify render mirrors canCloseWork; reviews name their basis (#3885, #3889, #3887)](https://github.com/Uuriko/project-room/pull/4046)
- [ ] **GH-PR-4045** — [perf(store): freezeJsonState incremental via a verified-frozen WeakSet (PERF-BUILDS P0-4)](https://github.com/Uuriko/project-room/pull/4045)
- [ ] **GH-PR-4044** — [Keep room projection cache warm across metadata commits](https://github.com/Uuriko/project-room/pull/4044)
- [ ] **GH-PR-4043** — [Records: stamp session-instance, principal, model/harness on consequential records (#3612)](https://github.com/Uuriko/project-room/pull/4043)
- [ ] **GH-PR-4042** — [perf(store): answer room metadata from memory (PERF-BUILDS P0-2)](https://github.com/Uuriko/project-room/pull/4042)
- [ ] **GH-PR-4041** — [Records: stamp session instance, authorizing principal, and claimed model/harness provenance (#3612)](https://github.com/Uuriko/project-room/pull/4041)
- [ ] **GH-PR-4040** — [fix(public-work): rate accounting — per-identity primary budget, per-IP admissions backstop (#3924)](https://github.com/Uuriko/project-room/pull/4040)
- [ ] **GH-PR-4039** — [Records: adverse-decision packet + agent-participation notices as records (#3615)](https://github.com/Uuriko/project-room/pull/4039)
- [ ] **GH-PR-4038** — [perf(store): keep the projection cache warm across non-rooms commits (PERF-BUILDS P0-3)](https://github.com/Uuriko/project-room/pull/4038)
- [ ] **GH-PR-4037** — [Records: auditor-grade decision-row export + evidence-read logging (#3616)](https://github.com/Uuriko/project-room/pull/4037)
- [ ] **GH-PR-4036** — [perf(jobs): stop the per-request job scan (PERF-BUILDS P0-1, supersedes #3809)](https://github.com/Uuriko/project-room/pull/4036)
- [ ] **GH-PR-4035** — [feat: bounty pricing guidance at post time from the room's settled receipts (#3524)](https://github.com/Uuriko/project-room/pull/4035)
- [ ] **GH-PR-4034** — [fix(board): focus repair on the Close-button and refused-claim paths (#3793 residual)](https://github.com/Uuriko/project-room/pull/4034)
- [ ] **GH-PR-4033** — [C-07 STATUS-LEG: job-materialized main-HEAD cache — status route serves cache only, board paints without the leg](https://github.com/Uuriko/project-room/pull/4033)
- [ ] **GH-PR-4032** — [P0-5: serve GET /api/auth/signin-options from the Worker (zero DO requests)](https://github.com/Uuriko/project-room/pull/4032)
- [ ] **GH-PR-4031** — [P0-6: wire archiveRoomMessages — owner-only operator route + 70%-of-cap job (dry-run by default)](https://github.com/Uuriko/project-room/pull/4031)
- [ ] **GH-PR-4030** — [COMP-DEEP #4: MCP annotation truth pass](https://github.com/Uuriko/project-room/pull/4030)
- [ ] **GH-PR-4029** — [P0-4: reuse verified frozen JSON projection subtrees](https://github.com/Uuriko/project-room/pull/4029)
- [ ] **GH-PR-4028** — [fix(receipts): settled lot receipts require the room's public-receipts opt-in (#3594)](https://github.com/Uuriko/project-room/pull/4028)
- [ ] **GH-PR-4027** — [feat(digest): server-side room digest + since-wake delta (C-06 ROOM-DIGEST)](https://github.com/Uuriko/project-room/pull/4027)
- [ ] **GH-PR-4026** — [fix(inbox): agent-inbox cursor walks ascending — bursts larger than the page are reachable (#3948)](https://github.com/Uuriko/project-room/pull/4026)
- [ ] **GH-PR-4025** — [COMP-DEEP #6: claim follow records with totals](https://github.com/Uuriko/project-room/pull/4025)
- [ ] **GH-PR-4024** — [records: decision records retention class >=4y + legal hold, audit-retention floor (#3614)](https://github.com/Uuriko/project-room/pull/4024)
- [ ] **GH-PR-4023** — [perf(escrow): closeEpoch due-filter — skip the isolated transaction for bounties that cannot act (AUDIT-50X X-06 / M-2)](https://github.com/Uuriko/project-room/pull/4023)
- [ ] **GH-PR-4022** — [COMP-DEEP #1: verdict inbox — attention set + sectioned read (server)](https://github.com/Uuriko/project-room/pull/4022)
- [ ] **GH-PR-4021** — [COMP-DEEP #1: verdict inbox — human surface](https://github.com/Uuriko/project-room/pull/4021)
- [ ] **GH-PR-4020** — [fix(escrow): served ledger reads provision outstanding genesis first (#3962)](https://github.com/Uuriko/project-room/pull/4020)
- [ ] **GH-PR-4019** — [perf(escrow): journal lot_state index — balance SUMs stop scanning whole accounts (AUDIT-50X X-08 / M-4)](https://github.com/Uuriko/project-room/pull/4019)
- [ ] **GH-PR-4018** — [Reviewer load (#3755): pending-review depth surface + less-loaded offering at delivery](https://github.com/Uuriko/project-room/pull/4018)
- [ ] **GH-PR-4017** — [Bounty pricing guidance at post time from the room's own settled receipts (#3524)](https://github.com/Uuriko/project-room/pull/4017)
- [ ] **GH-PR-4016** — [feat(receipts): receipt replay front end — timeline first, proof one click deeper (#3523)](https://github.com/Uuriko/project-room/pull/4016)
- [ ] **GH-PR-4015** — [feat(records): decision records get a >=4y legal-hold retention class (#3614)](https://github.com/Uuriko/project-room/pull/4015)
- [ ] **GH-PR-4014** — [Stop stale agent execution promptly when a request changes](https://github.com/Uuriko/project-room/pull/4014)
- [ ] **GH-PR-4013** — [fix(share-links): agent-facing copy states the access actually granted (#3961)](https://github.com/Uuriko/project-room/pull/4013)
- [ ] **GH-PR-4012** — [Records: criteria-level outcomes beyond the bounty lane (#3613)](https://github.com/Uuriko/project-room/pull/4012)
- [ ] **GH-PR-4011** — [fix(receipts): reconcile a PASS verdict with a rejected outcome on the receipt page (#3959)](https://github.com/Uuriko/project-room/pull/4011)
- [ ] **GH-PR-4010** — [Owner Cockpit slice 2: Money + Roster on /api/owner/overview (#3343)](https://github.com/Uuriko/project-room/pull/4010)
- [ ] **GH-PR-4009** — [fix(board): following a card's record link lands focus in the record (#3967)](https://github.com/Uuriko/project-room/pull/4009)
- [ ] **GH-PR-4008** — [Owner inbox #3340: account-home Needs Attention badge + per-room deep links from overview Decisions totals](https://github.com/Uuriko/project-room/pull/4008)
- [ ] **GH-PR-4007** — [fix(join): announce the post-sign-in name step, repair focus, trap Tab (#3796)](https://github.com/Uuriko/project-room/pull/4007)
- [ ] **GH-PR-4006** — [docs: best-of-N bounty attempts spec (#3527)](https://github.com/Uuriko/project-room/pull/4006)
- [ ] **GH-PR-4005** — [fix(invite): a shown create result owns the dialog's URL (#3794)](https://github.com/Uuriko/project-room/pull/4005)
- [ ] **GH-PR-4004** — [fix(offers): board-level statement that offers are agent-claimed (#3740)](https://github.com/Uuriko/project-room/pull/4004)
- [ ] **GH-PR-4003** — [fix(webhooks): dispatch honors guest (trial-seat) seating (#3881)](https://github.com/Uuriko/project-room/pull/4003)
- [ ] **GH-PR-4002** — [fix(work-claims): lease never lapses while a review is outstanding (#3753)](https://github.com/Uuriko/project-room/pull/4002)
- [ ] **GH-PR-4001** — [docs(escrow): dispute bond spec aligned to live exactly-25% rule (#3307) + true decide path (FS-13 F1)](https://github.com/Uuriko/project-room/pull/4001)
- [ ] **GH-PR-3999** — [#3307: dispute bond copy aligned to the implemented exactly-25% bond (comments/docs only)](https://github.com/Uuriko/project-room/pull/3999)
- [ ] **GH-PR-3996** — [Simplify sign-in and use invitation-link wording](https://github.com/Uuriko/project-room/pull/3996)
- [ ] **GH-PR-3995** — [COMP-DEEP #23: sponsor room cap at funding time (C1) + credit-exposure line (C2)](https://github.com/Uuriko/project-room/pull/3995)
- [ ] **GH-PR-3993** — [Fix Google sign-in after cross-site account selection](https://github.com/Uuriko/project-room/pull/3993)
- [ ] **GH-PR-3992** — [fix(front-door): #3957 static hero signage — cold answers + /about and /docs/agents links](https://github.com/Uuriko/project-room/pull/3992)
- [ ] **GH-PR-3991** — [fix(signin): #3771 preserve typed password across login/signup mode switch (F-12)](https://github.com/Uuriko/project-room/pull/3991)
- [ ] **GH-PR-3990** — [fix(invites): #3960 name the email-verification remedy; split share-link 422s per field](https://github.com/Uuriko/project-room/pull/3990)
- [ ] **GH-PR-3986** — [PERF-10X BUILD-LEAN: slim room_search_actions, lean-as-default MCP catalog, rev-skip (L5 iii)](https://github.com/Uuriko/project-room/pull/3986)
- [ ] **GH-PR-3985** — [fix(skill): SKILL.md money copy matches the shipped settlement reality (AEO)](https://github.com/Uuriko/project-room/pull/3985)
- [ ] **GH-PR-3984** — [fix(public-work): match declares and serves the reward classes the board serves (AEO drift)](https://github.com/Uuriko/project-room/pull/3984)
- [ ] **GH-PR-3983** — [test(evals): executable incident fixtures E1–E6 from escaped composition defects](https://github.com/Uuriko/project-room/pull/3983)
- [ ] **GH-PR-3979** — [fix: accept pasted human share links in the join form](https://github.com/Uuriko/project-room/pull/3979)
- [ ] **GH-PR-3978** — [fix(receipts): the owner's publish toggle no longer snaps back on interaction (#3968)](https://github.com/Uuriko/project-room/pull/3978)
- [ ] **GH-PR-3977** — [fix(invites): one-shot credential-less replay rotation per redemption receipt (#3949)](https://github.com/Uuriko/project-room/pull/3977)
- [ ] **GH-PR-3974** — [AEO B7: /agents copy — personal join link, not the parked referral token](https://github.com/Uuriko/project-room/pull/3974)
- [ ] **GH-PR-3973** — [Freeze-prep: rollback compatibility receipt (ee97df61→77df0e0b) + freeze-pair evidence/generator](https://github.com/Uuriko/project-room/pull/3973)
- [ ] **GH-PR-3972** — [AEO B5: receipt verification explainer (/receipts) + detail link](https://github.com/Uuriko/project-room/pull/3972)
- [ ] **GH-PR-3970** — [AEO B4: /offers SSR 'How paid work settles' passage](https://github.com/Uuriko/project-room/pull/3970)
- [ ] **GH-PR-3969** — [AEO B3+B6: /docs/agents/mcp subject page + docs OG/Twitter parity](https://github.com/Uuriko/project-room/pull/3969)
- [ ] **GH-PR-3966** — [AEO B2: root definition block + SoftwareApplication JSON-LD](https://github.com/Uuriko/project-room/pull/3966)
- [ ] **GH-PR-3965** — [AEO B1+B8: funded-work truth in llms.txt/llms-full.txt/agent card, llms-full superset, robots AI crawlers](https://github.com/Uuriko/project-room/pull/3965)
- [ ] **GH-PR-3955** — [Let owners remove people from People without closing the phone drawer](https://github.com/Uuriko/project-room/pull/3955)
- [ ] **GH-PR-3952** — [fix(escrow): finalizeBounty pays an approved bounty through the per-bounty door (#3693 residual)](https://github.com/Uuriko/project-room/pull/3952)
- [ ] **GH-PR-3951** — [Remove dead owner-alerts dispatcher (R-2) and availablePublicTasks (R-3)](https://github.com/Uuriko/project-room/pull/3951)
- [ ] **GH-PR-3936** — [Events 422: tail/compact refusals get a hint about the value they name](https://github.com/Uuriko/project-room/pull/3936)
- [ ] **GH-PR-3933** — [Connect shared work to native Mac setup, computer tools, and readiness](https://github.com/Uuriko/project-room/pull/3933)
- [ ] **GH-PR-3859** — [Timeline: skip the selection read on arrivals when nothing is selected](https://github.com/Uuriko/project-room/pull/3859)
- [ ] **GH-PR-3857** — [Cut dead reaction storage, growth reaction mapping, and an unwired QA check](https://github.com/Uuriko/project-room/pull/3857)
- [ ] **GH-PR-3848** — [Nav: Back after opening a message link returns to where you were](https://github.com/Uuriko/project-room/pull/3848)
- [ ] **GH-PR-3846** — [Login font 140 KB -> 4.6 KB; document short merge-slot leases and code drops](https://github.com/Uuriko/project-room/pull/3846)
- [ ] **GH-PR-3845** — [Composer: mark a landed send Sent when its response was lost (12609 a)](https://github.com/Uuriko/project-room/pull/3845)
- [ ] **GH-PR-3841** — [WORKOF-GUARD: validate mapped rows in syncWorkItemClaim (#3465 parity, find:work-item-board-002)](https://github.com/Uuriko/project-room/pull/3841)
- [ ] **GH-PR-3840** — [T-4 VACUOUS-HARDEN: gates that cannot fail, made able to fail (OPP-012)](https://github.com/Uuriko/project-room/pull/3840)
- [ ] **GH-PR-3839** — [T-1 MEMBERS-SWEEP: raw members( → ownMember burn-down (OPP-003, #3224)](https://github.com/Uuriko/project-room/pull/3839)
- [ ] **GH-PR-3838** — [T-6 dead-verdicts: execute P-15 verdict batch (OPP-018, F-38/F-39)](https://github.com/Uuriko/project-room/pull/3838)
- [ ] **GH-PR-3836** — [Registry-closure census gate + writer-fence closure test (T-5 / OPP-015)](https://github.com/Uuriko/project-room/pull/3836)
- [ ] **GH-PR-3834** — [Tier KV backup retention: 7 daily + 4 weekly + 3 monthly TTL classes (C-04)](https://github.com/Uuriko/project-room/pull/3834)
- [ ] **GH-PR-3833** — [C-02 RELAY-DELETE: delete the undeployed relay/ Worker + relay.yml](https://github.com/Uuriko/project-room/pull/3833)
- [ ] **GH-PR-3832** — [fix(context): stop embedding orient in HTTP context responses (C-01 ORIENT-FIX)](https://github.com/Uuriko/project-room/pull/3832)
- [ ] **GH-PR-3821** — [Backup gzip transport + per-table byte tally in export trailer (PERF-10X CALL 1)](https://github.com/Uuriko/project-room/pull/3821)
- [ ] **GH-PR-3820** — [PERF-10X L1 (schema v39): VIRTUAL generated columns + indexes for the hot event fields](https://github.com/Uuriko/project-room/pull/3820)
- [ ] **GH-PR-3818** — [fix(reviews): knownMember through ownMember — prototype ids cannot pass the membership gate (F-22)](https://github.com/Uuriko/project-room/pull/3818)
- [ ] **GH-PR-3817** — [fix(cloudflare): wire orphaned checks (code-drops, room-export, restore-fk-order) + registry closure guard (F-27)](https://github.com/Uuriko/project-room/pull/3817)
- [ ] **GH-PR-3815** — [perf(ci): refresh unit shard durations from hosted receipts (+ durations-refresh workflow in annex)](https://github.com/Uuriko/project-room/pull/3815)
- [ ] **GH-PR-3812** — [verify:pr — local/hosted gate parity in one command (PERF-10X L14)](https://github.com/Uuriko/project-room/pull/3812)
- [ ] **GH-PR-3811** — [Memoize public-work reseed gate per DO wake (PERF-10X L11)](https://github.com/Uuriko/project-room/pull/3811)
- [ ] **GH-PR-3810** — [perf(sse): skip and cache the stream pump's redaction view (PERF-10X L12 / CALL 4)](https://github.com/Uuriko/project-room/pull/3810)
- [ ] **GH-PR-3809** — [perf(jobs): arm already-due explicit jobs at ~now, not +60 s (PERF-10X L12 / Lane 8 C4)](https://github.com/Uuriko/project-room/pull/3809)
- [ ] **GH-PR-3804** — [perf(reads): lot index, proof-page SQL LIMIT, sitemap batch (PERF-10X L13)](https://github.com/Uuriko/project-room/pull/3804)
- [ ] **GH-PR-3752** — [fix(sessions): work-session idempotency matcher covers usage figures and budget (#3697)](https://github.com/Uuriko/project-room/pull/3752)
- [ ] **GH-PR-3751** — [fix(directory): receipt_count credits only visible receipts, matched by identity not display name (#3705)](https://github.com/Uuriko/project-room/pull/3751)
- [ ] **GH-PR-3748** — [fix(events): resolve channels through an own-key helper (#3694)](https://github.com/Uuriko/project-room/pull/3748)
- [ ] **GH-PR-3738** — [Name the refused fields in every invalid_public_work 422 (#3650)](https://github.com/Uuriko/project-room/pull/3738)
- [ ] **GH-PR-3737** — [fix(public-work): board claimability accounts for live path fences (#3649)](https://github.com/Uuriko/project-room/pull/3737)
- [ ] **GH-PR-3735** — [Ready queue applies the AvailableWork eligibility rule (#3713)](https://github.com/Uuriko/project-room/pull/3735)
- [ ] **GH-PR-3734** — [fix(board): stop projecting lapsed work-item leases onto board rows (#3711)](https://github.com/Uuriko/project-room/pull/3734)
- [ ] **GH-PR-3730** — [docs(wake): correct the packet's polling-without-hostId claim (#3640)](https://github.com/Uuriko/project-room/pull/3730)
- [ ] **GH-PR-3724** — [EXP-5 PR2: receipt share block, embeddable verdict badge, proof-page share parity](https://github.com/Uuriko/project-room/pull/3724)
- [ ] **GH-PR-3714** — [feat(board): brief readers resolve definitionOfDone + mode board-first (B-4' Phase 0 slice 3b)](https://github.com/Uuriko/project-room/pull/3714)
- [ ] **GH-PR-3696** — [docs(cold walkthrough): seven public MCP tools, and rotate needs {confirm:true}](https://github.com/Uuriko/project-room/pull/3696)
- [ ] **GH-PR-3695** — [Operator status surface (2/4): integrity, backup, board, behaviour tiles](https://github.com/Uuriko/project-room/pull/3695)
- [ ] **GH-PR-3692** — [Operator status surface (4/4): console Deployment status section](https://github.com/Uuriko/project-room/pull/3692)
- [ ] **GH-PR-3691** — [fix(public-work): versioned walk cursor — board pagination exactly-once under mid-walk claims (#3606)](https://github.com/Uuriko/project-room/pull/3691)
- [ ] **GH-PR-3690** — [docs(quickstart): name the accountable-member rule for work.completed](https://github.com/Uuriko/project-room/pull/3690)
- [ ] **GH-PR-3665** — [Human error copy: dedicated strings for 5 fragment-copy codes (census F-1)](https://github.com/Uuriko/project-room/pull/3665)
- [ ] **GH-PR-3663** — [fix(wake): cadence-aware wakeability window (#3592)](https://github.com/Uuriko/project-room/pull/3663)
- [ ] **GH-PR-3662** — [Mystery Shopper prototype: shopper-report/1 schema + cold-door runner (#3660)](https://github.com/Uuriko/project-room/pull/3662)
- [ ] **GH-PR-3657** — [Operator status surface (3/4): Worker providers — heartbeat + backup measurement](https://github.com/Uuriko/project-room/pull/3657)
- [ ] **GH-PR-3652** — [feat(board): brief carriage - definitionOfDone + mode on work-claim rows (B-4' Phase 0 slice 3a)](https://github.com/Uuriko/project-room/pull/3652)
- [ ] **GH-PR-3647** — [Discovery metadata: MCP Registry description names the work loop (server.json 1.1.1) + README registry link](https://github.com/Uuriko/project-room/pull/3647)
- [ ] **GH-PR-3646** — [Operator status surface (1/3): composed deployment + jobs read](https://github.com/Uuriko/project-room/pull/3646)
- [ ] **GH-PR-3645** — [Fix #3591: self-finalizing bounty escrow entry points (deadline/challenge race)](https://github.com/Uuriko/project-room/pull/3645)
- [ ] **GH-PR-3643** — [Agent errors: operator-directed recoveries for config codes + catalog invalid_proof_query (census F-3/F-4)](https://github.com/Uuriko/project-room/pull/3643)
- [ ] **GH-PR-3641** — [feat(board): accountableMemberId on work-claim rows (B-4' Phase 0 slice 4)](https://github.com/Uuriko/project-room/pull/3641)
- [ ] **GH-PR-3638** — [fix(supply-chain): align sharp override at 0.35.5; pin runbook wrangler (#3579)](https://github.com/Uuriko/project-room/pull/3638)
- [ ] **GH-PR-3632** — [docs: DR restore runbook from the 2026-10-15 game day (measured RTO ~60s) + BACKUP-DR corrections](https://github.com/Uuriko/project-room/pull/3632)
- [ ] **GH-PR-3630** — [MCP 500 copy: kill 'Request could not be completed' (error census F-2)](https://github.com/Uuriko/project-room/pull/3630)
- [ ] **GH-PR-3629** — [feat(board): decision-gate fields on work-claim rows (B-4' Phase 0 slice 2)](https://github.com/Uuriko/project-room/pull/3629)
- [ ] **GH-PR-3622** — [Guard the R2 backup target until it is restorable (#3585)](https://github.com/Uuriko/project-room/pull/3622)
- [ ] **GH-PR-3621** — [fix(account-deletion): tear down a sole-owned room's public footprint on deletion](https://github.com/Uuriko/project-room/pull/3621)
- [ ] **GH-PR-3620** — [fix(feedback): redact first-party credential prefixes (pri_/rak_/ga1.) at intake](https://github.com/Uuriko/project-room/pull/3620)
- [ ] **GH-PR-3611** — [Board actions: unconfirmed-outcome copy on transport failure (fixes #3596)](https://github.com/Uuriko/project-room/pull/3611)
- [ ] **GH-PR-3604** — [fix(supply-chain): skill installer copies from the checkout, never fetches from main (#3577)](https://github.com/Uuriko/project-room/pull/3604)
- [ ] **GH-PR-3600** — [refactor(members): ownMember migration slice 6 — share-links (#3224)](https://github.com/Uuriko/project-room/pull/3600)
- [ ] **GH-PR-3593** — [fix(boot): instance lock binds holder identity (pid + start ticks) — reused pid no longer wedges boot (#3584)](https://github.com/Uuriko/project-room/pull/3593)
- [ ] **GH-PR-3590** — [feat(attention): wire owner-alerts (O2) as the escalation engine (B-3 step 3 PR4)](https://github.com/Uuriko/project-room/pull/3590)
- [ ] **GH-PR-3586** — [refactor(members): ownMember migration slice 3 — work surfaces (#3224)](https://github.com/Uuriko/project-room/pull/3586)
- [ ] **GH-PR-3582** — [refactor(members): ownMember migration slice 4 — money/public surfaces (#3224)](https://github.com/Uuriko/project-room/pull/3582)
- [ ] **GH-PR-3580** — [refactor(members): ownMember migration slice 5 — comms/identity tail (#3224)](https://github.com/Uuriko/project-room/pull/3580)
- [ ] **GH-PR-3575** — [refactor(attention): bonds + bounty clocks read the aging doctrine (B-3 step 2 PR2)](https://github.com/Uuriko/project-room/pull/3575)
- [ ] **GH-PR-3574** — [feat(push): decision push class for decision asks (B-3 step 3, E63)](https://github.com/Uuriko/project-room/pull/3574)
- [ ] **GH-PR-3573** — [feat(attention): one aging doctrine + scheduled access-request expiry (B-3 step 2 PR1)](https://github.com/Uuriko/project-room/pull/3573)
- [ ] **GH-PR-3571** — [AvailableWork true (B-2 PR3): named exceptions — opportunities + room matchmaking, documented and pinned](https://github.com/Uuriko/project-room/pull/3571)
- [ ] **GH-PR-3569** — [AvailableWork true (B-2 PR4): matcher candidate window reads through the projection](https://github.com/Uuriko/project-room/pull/3569)
- [ ] **GH-PR-3568** — [refactor(members): ownMember migration slice 2 — store core (#3224)](https://github.com/Uuriko/project-room/pull/3568)
- [ ] **GH-PR-3564** — [refactor(members): ownMember migration slice 1 — joining/authz paths (#3224)](https://github.com/Uuriko/project-room/pull/3564)
- [ ] **GH-PR-3563** — [AvailableWork true (B-2 PR2): public arm wired in — claimable read served through the projection](https://github.com/Uuriko/project-room/pull/3563)
- [ ] **GH-PR-3562** — [AvailableWork true (B-2 PR1): projection fields for ranking consumers](https://github.com/Uuriko/project-room/pull/3562)
- [ ] **GH-PR-3556** — [Fence core work claims: claimGeneration round token + state-machine lease enforcement](https://github.com/Uuriko/project-room/pull/3556)
- [ ] **GH-PR-3507** — [fix: label read Updates accurately](https://github.com/Uuriko/project-room/pull/3507)
- [ ] **GH-PR-3506** — [Simplify conversation chrome and make first Room requests dependable](https://github.com/Uuriko/project-room/pull/3506)
- [ ] **GH-PR-3400** — [build(deps): bump astral-sh/setup-uv from 6.8.0 to 10.3.0](https://github.com/Uuriko/project-room/pull/3400)
- [ ] **GH-PR-3399** — [chore(deps): bump actions/checkout from 4.4.0 to 7.0.1](https://github.com/Uuriko/project-room/pull/3399)
- [ ] **GH-PR-3398** — [build(deps): bump actions/download-artifact from 4.3.0 to 8.0.2](https://github.com/Uuriko/project-room/pull/3398)
- [ ] **GH-PR-3397** — [chore(deps): bump actions/upload-artifact from 4.6.2 to 7.0.2](https://github.com/Uuriko/project-room/pull/3397)
- [ ] **GH-PR-3396** — [build(deps): bump actions/cache from 4.2.3 to 6.1.0](https://github.com/Uuriko/project-room/pull/3396)
- [ ] **GH-PR-3395** — [build(deps-dev): bump the minor-and-patch group across 1 directory with 2 updates](https://github.com/Uuriko/project-room/pull/3395)
- [ ] **GH-PR-3394** — [build(deps-dev): bump the minor-and-patch group across 1 directory with 4 updates](https://github.com/Uuriko/project-room/pull/3394)
- [ ] **GH-PR-3393** — [build(deps-dev): bump wrangler from 4.116.0 to 4.149.0 in /cloudflare in the minor-and-patch group across 1 directory](https://github.com/Uuriko/project-room/pull/3393)
- [ ] **GH-PR-2104** — [Bound oversized KV backup rows and preserve exact bytes](https://github.com/Uuriko/project-room/pull/2104)
- [ ] **GH-PR-2006** — [Keep attachment drafts and retries reliable; add Enter preference](https://github.com/Uuriko/project-room/pull/2006)
- [ ] **GH-PR-2003** — [Reduce human composer bulk and prioritize the experience backlog](https://github.com/Uuriko/project-room/pull/2003)
- [ ] **GH-PR-1791** — [Fix push opt-out recovery and trace workflow review handoff](https://github.com/Uuriko/project-room/pull/1791)

## Machine-readable inventory

- [Canonical task inventory](backlog/project-room-total-backlog.json)
- [Captured issue metadata](backlog/github-open-issues-2026-10-18.json)
- [Captured PR metadata](backlog/github-open-prs-2026-10-18.json)
- [Execution packages](BUILD-TO-COMPLETION-PLAN.md)
- [Original delivery ledger](DELIVERY-LEDGER.md)

No generated checkbox is checked by default. Unknown implementation state remains unknown until reconciled.

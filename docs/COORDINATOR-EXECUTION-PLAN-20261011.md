# Coordinator implementation plan and execution receipt

This plan turns the Notion/coordinator design into small reviewable changes. Preserve the current chat layout and existing run/attempt protocol. Do not add a second orchestration database or a compulsory Notion dependency.

## Batch 1: reliable server admission and discovery

### Atomic request admission

Add an optional `message` to `invoke` on the existing assistant endpoint. The server writes the normal message command and the assistant run within the same transaction. Validate normal message permissions, channel, body and reply rules through the existing command implementation. Retain the existing source-message invocation form for clients already posting separately.

Use stable request, run and source-message IDs. A successful retry returns the same receipt; changed input under the same operation ID is rejected. Derive the nested command ID from actor and request ID. No caller can supply another author or use this path for a private message. Rejection, including unavailable coordinator or run collision, must roll back message and run writes.

Implemented: `server/room-assistant.mjs`, `server/routes/room-assistant.mjs`.

### Persistent discovery

The existing opt-in `--watch` command runs oldest queued unclaimed work serially through the established shared runtime. Add a bounded read deadline and preserve cancellation. Never infer working state from discovery alone. Never claim another host's attempt. Stop on uncertain execution failure; explicit same-journal recovery remains required.

Superseded: the watcher from957cd667 was removed. Current local integration uses `client/codex-supervisor.mjs` and CLI wiring from PR2612. See the reconciliation correction below.

### Acceptance

Test exact retry, altered retry, unavailable coordinator rollback, run-collision rollback, invalid channel/private payload, agent impersonation rejection, idle cancellation, stalled read, and atomic admission through actual discovery and fenced threaded publication. Existing shared runtime tests continue to own model-session, late-input, stop and publication recovery behavior.

Retained tests: `tests/assistant-admission.test.js` and existing `tests/codex-supervisor.test.js`. The redundant watcher test file was removed with its implementation. These use real Room HTTP/server/storage paths where relevant. The lifecycle test substitutes the model execution and therefore does not prove provider authentication or real model quality.

## Batch 2: use atomic admission in the composer

This remains required; the server change alone does not fix the browser's existing two-operation path.

1. Carry Ask Room intent with the exact persisted pending draft so reload and retries cannot downgrade an ask into ordinary chat.
2. Use the combined operation for plain public asks; preserve attachment ordering until their transaction boundary is explicitly handled.
3. Keep local echo keyed to the same source message ID. Distinguish stored/admitted from host pickup; no synthetic acceptance message.
4. Clear only the originating draft after an authoritative receipt. Preserve another room/thread's draft during navigation.
5. On a lost response retry the same operation. Do not fall back to separate message creation after an ambiguous result.
6. Integrate with PR2683's receipt-first UX rather than overwrite it. Qualify mixed-version deployment: API support must precede a client that depends on it, or the client must discover supported features safely.
7. Browser tests: lost response then reload/retry; double Enter; rejection; account/room switch during send; old server compatibility; attachments; visible exact-once message and run; no idle setup noise.

## Batch 3: make a live host genuinely available

1. Check current room coordinator, qualified host and ownership through live API. The latest successful check returned coordinatorMemberId=null, revision0. Recheck before activation; delivered owner request is not proof of a configured host.
2. Use one dedicated Room identity with the existing owner-controlled configuration endpoint; do not borrow another agent's credentials or silently change the user's account.
3. Qualify the dedicated runtime's provider authentication with a bounded real task, then run the watcher under a documented supervisor.
4. Add idle readiness independent of in-flight runs: scoped host session, heartbeat expiry, provider readiness and capacity.
5. Test a real human request, two-human contribution, streamed result and Stop before calling it connected.
6. On host loss show the request's retained state and useful recovery. Automatic restart must reconcile existing attempts and external outcomes before new execution.

## Batch 4: responsive multiplayer scheduling

Preserve one Room identity but separate conversation execution contexts. Build on current work claims for conflicting resources. Add a bounded pool and fair scheduling only after host capacity is explicit. A long build must not block another person's status question. Replies normally contribute to the current request; unrelated asks create separate requests; conflicts require an explicit resolution. Preserve requester attribution and visibility throughout.

Inspect open changes-feed PR2633 before adding another poll/feed design. Use cursor/reconnect semantics to reduce full projection reads. Record receipt, admission, pickup, first useful response and completion times separately.

## Batch 5: useful delegation and maintained memory

Delegate with objective, scope, context references, budget and evidence expectations. Route child results to the parent run, propagate cancellation and deduplicate late results. Validate required outputs before completion; a worker's success claim is not evidence by itself.

Extend existing room/work context and charter before building a new memory service. Borrow Lore's scope, expiry and supersession patterns; keep access enforcement in Room. Separate operational receipts from durable knowledge, citation frequency from confidence, and sourced decisions from inferred summaries. Evaluate outcomes against no-memory, stale-memory and conflicting-memory conditions.

## Release gates and scope

Run focused tests, affected tests, lint and the required full suite before push. Exact-head hosted CI and the merge/deploy lane still govern release. Keep API/backend support backward compatible and qualify the frontend separately. No live credentials, owner configuration, startup service or production deployment is changed by Batch 1.

Batch 1 is the current implemented scope. Batches 2–5 are explicit unfinished work, not claims of shipped functionality. Detailed design rationale and primary sources are in `NOTION-COORDINATOR-20261011.md`.

## Batch 1 verification receipt

- Focused admission, discovery, assistant contracts and shared runtime: 64 passed.
- Broader affected suite: 1,309 passed across 238 files.
- Lint: zero errors, 127 existing warnings; design-token, reachability and i18n checks passed.
- No production activation, frontend adoption, full-suite green claim, merge or deployment.

## Reconciliation correction

PR2612 (`147c1027`) already implements persistent shared pickup, exclusive ownership,
owned-attempt recovery, persisted backoff and bounded reads. The local simpler watcher
was redundant and is retired. Integrate PR2612 rather than ship two supervisors.
Keep atomic admission and its independent tests. The earlier watcher test counts above
are historical evidence for the retired implementation, not qualification of the
replacement. Rerun the existing supervisor/runtime suites after integration.

# Consolidated product backlog

This extends the coordinator plan rather than replacing it. Coordinator delivery stays
first. The open implementation inventory is [OPEN-PR-RECONCILIATION-20261011.md](OPEN-PR-RECONCILIATION-20261011.md): 449 open PRs observed on October 11. It captures all PRs returned by that query, not every uncommitted branch or every historical promise. Existing plans reviewed include HUMAN-EXPERIENCE-PLAN-20261006.txt, MAC-POWER-PLAN-20261006.txt, PRODUCT-CONSOLIDATION-PLAN-2026-09-30.md, and FINISH-BACKLOG.md at 3b20363a. Historical proposals must be reconciled with code before becoming new tasks.

## Status vocabulary and ownership

- **Local:** source/checkpoint exists; not a shipping claim.
- **Open PR:** reviewable source exists; exact head and current CI must be checked.
- **Integration:** combining existing implementations; qualify their interaction.
- **Unverified:** present or previously attempted, but intended end-to-end behavior lacks proof.
- **Proposed:** evaluate/build only after checking existing code and value.
- **Live verified:** observed against a named deployed/installed revision with a reproducible receipt.

Root owns integration and this priority order. Agent lanes are claimed per concrete file/task;
PR authorship is not a current work assignment. Do not wait indefinitely for a peer response:
continue independent work and preserve the unanswered dependency. Do not create duplicate
implementations because an existing one is unmerged.

## P0 — finish the human request loop

| ID | Work and current state | Completion evidence |
| --- | --- | --- |
| C01 | Atomic admission, local95bdbde7; preserve backward-compatible optional message payload | One message + one run or neither; exact retry and authorization tests |
| C02 | Wire atomic admission into web/shared desktop composer; unfinished | Reload/lost receipt/double Enter/account switch preserve intent and produce one run |
| C03 | Adopt existing PR2612 supervisor; local integration replaces redundant watcher | Owned recovery before new work; exclusive host; stop/restart/backoff tests |
| C04 | Configure and qualify a real muse-room coordinator; unverified | Actual authenticated model run replying to a human in the original conversation |
| C05 | Immediate message display and admission receipt feedback; PR2683 plus local837a83c9 | Slow-network browser proof, usable composer, no fabricated working/typing |
| C06 | Idle host readiness, provider readiness and capacity; incomplete | Expiring health independent of active requests; disconnect visible without false availability |
| C07 | Integrate useful pieces of changes-feed PR2633 and resume context PR2631 | Cursor replay/reconnect and scoped reads; no competing feed implementations |
| C08 | Late input, edits, conflicting direction, pause/resume/Stop; existing mechanisms need integrated qualification | Two humans steer one real run; cancelled or replaced attempt cannot publish |
| C09 | Failure feedback and recovery; incomplete | No silent stranded ask, no duplicate external action after lost response |
| C10 | Parallel independent conversations and fair queueing; proposed | Long build does not monopolize simple unrelated requests; resource conflicts remain serialized |

Gate to leave P0: a human can ask, see acknowledgment, get actual pickup, add a correction,
receive one useful result and stop execution on both website and installed desktop. Report
partial readiness until this is observed. Historical owner DM `coordinator-pickup-owner-1011`
was committed at sequence11938; it is a delivered request, not proof of owner action.

## P0 — account access and release correctness

| ID | Work and current state | Completion evidence |
| --- | --- | --- |
| A01 | Native Google return/cancel/back recovery, PR2651; real completion unverified | Real desktop sign-in succeeds; cancellation and timeout restore usable login without restart |
| A02 | Email/password signup/login/reset; run current journeys before changing design | New human reaches usable room, credentials errors preserve input, recovery works |
| A03 | Invite destination across signup/OAuth and app launch | Correct room/identity after redirect, retry and desktop deep link |
| A04 | GitHub sign-in, PR2652; deployment configuration previously missing | Only show configured provider; real callback works on web and desktop |
| A05 | Minimal sign-in screen and green cube identity | Logo/wordmark and essential auth controls only; correct Dock/app icon in installed artifact |
| A06 | Optional passkey setup after account entry; verify existing implementation first | Enrollment/login/recovery work without adding an onboarding gate |
| A07 | Requested human admin access; owner-dependent/unverified | Read back intended permissions for exact human member, never infer from display name |
| R01 | Reconcile source, CI, deployed version and installed native version | One release manifest identifies each exact artifact and qualification result |
| R02 | Resolve full-suite failures before green release claims | Failures classified, reproduced and fixed or explicitly justified; exact-head hosted CI green |
| R03 | Merge/deploy serialization and rollback | One lane owner, tested rollback, post-deploy web/native/account/agent smoke |
| R04 | Signed/notarized desktop distribution/update path | Reproducible install/update/rollback, preserved sessions, documented signing limitations |

## P1 — fast, calm everyday collaboration

| ID | Work | Completion evidence |
| --- | --- | --- |
| H01 | Ship local echo/typing and warm cache work from2674/2673/2683 coherently | Measured receipt/pickup latency; no duplicate messages, stale permissions or full-history reload storms |
| H02 | Unify assistant output into conversation, keep worker detail optional | One stable result, expandable useful activity, no default swarm console |
| H03 | Drafts across threads, rooms, reload, navigation and failures | Exact scoped recovery; another destination's draft never cleared by late response |
| H04 | Thread behavior and message menus | Replies stay scoped; menus/focus survive updates; no unrelated claim noise |
| H05 | Saved message behavior observed ambiguous during desktop QA | Save/unsave changes state and persists; saved view opens exact source |
| H06 | Attachments and resulting artifacts | Upload/retry/cancel/download/preview work; no orphaned or inaccessible shared result |
| H07 | Search and navigation | Useful results, paging, source jump, back behavior and access filtering |
| H08 | Unread/catch-up/notifications | Same cursor and visibility across badge/panel; read, delivered and answered stay distinct |
| H09 | Invite, member identity, mentions and optional direct agent interaction | Reliable links; exact recipient identity; no accidental broad audience |
| H10 | Everyday Slack/Discord affordances | Verify edit/delete/reply/reaction/copy-link/keyboard navigation before adding substitutes |
| H11 | Accessible, responsive conversation | Keyboard-only flow, visible focus, screen reader feedback, contrast, reduced motion and small-screen input |
| H12 | Remove redundant panels, labels and empty states | No idle disconnected/project panel; advanced tools remain reachable when relevant |
| H13 | Returning to ongoing work | Resume last room/scroll/draft; compact relevant progress with source links |

Consolidate existing UI before a framework migration. A React/chat-component rewrite is
an evaluated implementation choice, not automatically a feature. Require a concrete
benefit, parity tests and removal of the superseded renderer before expanding it.

## P1 — agents that can reliably get work done

| ID | Work | Completion evidence |
| --- | --- | --- |
| G01 | One agent connection/setup/resume path | Existing identity retained; host receives and answers a real request |
| G02 | Typed machine actions, discovery, compact context and batching | Common work uses direct tools/API rather than human-speed clicking |
| G03 | Clear action/result/error contracts across MCP/CLI/HTTP | Same authority and idempotency behavior; errors identify a usable next step |
| G04 | Scoped delegation and parent/child result routing | No overlapping accidental edits; one public synthesized result with provenance |
| G05 | Budgets and deadlines | Actual usage associated with work; useful partial result on exhaustion |
| G06 | Advisory agent work-fit, PR1995 candidate | Attributed outcomes, uncertainty and task types; no unsupported universal agent rankings |
| G07 | Readiness and acknowledgment telemetry | Delivery/pickup/response measured separately; no claim that an unread post was acted on |
| G08 | Portable tools/skills and instructions | Versioned usable packages; small accurate entry docs; no duplicate setup instructions |
| G09 | Stop controls and uncertain native/remote actions | Propagation and effect reconciliation tested; no global exactly-once promise |

## P1 — desktop integration and computer access

| ID | Work | Completion evidence |
| --- | --- | --- |
| D01 | Isolated-home desktop tool connection, PR2611 | Copied configuration reaches correct saved room without ambient credential lookup |
| D02 | Accessibility/window capture tools, PR2614 | Real selected-app round trip; correct permissions, private artifacts and bounded retention |
| D03 | File/process tools and working directories | Scope is explicit, results return to originating run, cancellation is observed |
| D04 | Native observation plus action loop | Real app interaction succeeds; target window identity remains correct after focus changes |
| D05 | Deep computer setup | Explain actual OS grants/connectors; no checkbox falsely claiming unrestricted access |
| D06 | Background host lifecycle and wake/sleep | Optional startup, visible status, recoverable disconnection, stop/uninstall behavior |
| D07 | Web versus desktop capability presentation | Browser does not promise local tools without a connected host; same shared conversation |
| D08 | Email/calendar/app connectors | Add only complete authorized workflows; verify existing connections before building duplicates |
| D09 | Linux/other platform stance | Document supported tested capabilities; avoid presenting an unfinished package as parity |

## P2 — durable knowledge, work and results

- M01: Keep room/work context canonical; compact summaries reference original evidence.
- M02: Adopt sourced decisions, procedures, scope, expiry and supersession from Lore's useful patterns.
- M03: Keep operational receipts temporary; separate personal preferences from shared room instructions.
- M04: Detect contradictions and stale memory; edits/deletion/revocation affect derived context.
- M05: Evaluate retrieval and downstream task success/harm independently.
- M06: Optional Lore/Notion connector for existing customers; no mandatory external memory backend.
- W01: One chat-to-work-to-result lifecycle, with dashboards as views of the same records.
- W02: Put review and corrections beside the exact result version.
- W03: Shared editable artifacts only after a demonstrated need; use established collaboration primitives.
- W04: Preserve evidence, dependencies, handoffs and partial outcomes without exposing machine bookkeeping by default.
- W05: Reliable export, backup and restore; verify integrity and privacy after recovery.

## P2 — engineering simplification and operations

- E01: Reconcile the entire open-PR inventory: retained carrier, superseded carrier, already present, obsolete, or needs proof. Record why; do not mass-close based only on title.
- E02: Audit unpushed local checkpoints and worker handoffs against the same inventory.
- E03: Collapse duplicate watchers, connection flows, status calculations and projections only after behavioral comparison.
- E04: Remove dead code and stale documentation with coverage of remaining entry points.
- E05: Profile hot paths with realistic room size; separate frontend render, network, auth, storage and model costs.
- E06: Bound history/context/attachment reads and caches; preserve fresh authorization.
- E07: Add actionable diagnostics with request/run IDs and redaction; avoid noisy chat logs.
- E08: Keep public docs, API/MCP schemas, packaged runtime and deployed features in agreement.
- E09: Add versioned migration/rollback qualification for shared SQLite/Cloudflare/native boundaries.
- E10: Maintain a compact acceptance suite around complete user journeys; remove redundant tests only with evidence of overlap.

## P3 — growth and revenue after the core loop works

- B01: Define and observe first useful result, invited collaborator activation and repeat project use.
- B02: Evaluate hosted runtime/convenience plans with transparent budgets; no surprise agent spend.
- B03: Skill/app marketplace discovery, versioning, compatibility and publisher trust before payments.
- B04: Complete purchase/install/use/update/remove as one workflow before marketplace expansion.
- B05: Keep open-source setup usable; document what is self-hosted versus hosted convenience.
- B06: Test specific templates/use cases with real work rather than a large onboarding template grid.
- B07: Avoid adding billing, rewards, rankings or dashboards to the default conversation unless they solve a demonstrated need.

These are product directions, not authorization to charge money, contact outside users,
or provision new paid services.

## Execution order after coordinator delivery

1. Qualify current login/invite + two-human/one-Room real work on web and installed desktop.
2. Integrate the smallest coherent speed/auth/coordinator release; fix release blockers and record rollback.
3. Complete everyday chat reliability and the proven native tool round trip.
4. Improve parallel scheduling, delegation, context quality and agent machine ergonomics.
5. Consolidate UI/code and retire superseded implementations with parity evidence.
6. Evaluate retention/usefulness, then expand hosting/skills monetization with complete flows.

Every retained item needs a source/checkpoint, current owner/claim, smallest useful
implementation, dependencies, acceptance proof and release state. Do not turn the list
into a standing requirement to add all proposed features. Reprioritize using observed
user friction and real work outcomes. A plan entry is never completion evidence.

## Consolidation verification receipt

Existing PR2612 source was integrated as632544c9,8022a79f,4401de0b after retiring the duplicate watcher in81b5f753. Atomic admission remains present. Admission, supervisor, runtime, shared-assistant and stdio suites:59 passed. Lint:zero errors,127 warnings. This is local qualification, not an authenticated provider run or a deployment.

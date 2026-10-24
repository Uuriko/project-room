# Project Room: human, agent and laptop qualification

Date: 2026-10-23 (America/Los_Angeles). This is an execution plan and evidence ledger, not a claim that the system is fully implemented. Source baseline: aa96b82b. First repair branch: codex/dual-role-ux-1023. Room task: codex-dual-role-ux-1023.

## Goal and completion criterion

A person should be able to request useful work, understand who is responsible, see real execution, inspect an artifact, request a revision and accept the result from Project Room. An agent should be able to discover only the relevant context, reserve work, invoke bounded local capabilities, recover interruption and return versioned evidence through the same system. Laptops should execute routine processing without a model call and expose honest capacity and health.

“All work in Room” means Room owns the user-facing request, durable state, resource dispatch, evidence and recovery. Compilers and Git may run locally under a supervised worker. A person should not need to open a terminal to repair an ordinary failed request. Development tools used to build this capability are currently outside Room; that is a qualification gap, not a success.

## Test discipline

Use the human Default profile (observed account: uuriko) and a separate agent profile (observed member: Codex). Confirm the account before every write. Label simulated human requests as entered by the assistant on John's behalf. Preserve attribution; simulated human acceptance is not independent human review. Do not expand permissions merely to make a test pass. A display name is not proof of room ownership.

Use real, bounded tasks: repair a UI bug, review its exact diff, run a fixed repository test recipe, generate a useful report, request a correction, and inspect evidence. Keep production writes to scoped tasks and reports. Use a local acceptance fixture for offline faults, permission failures, lost acknowledgements, cancellation races and destructive edge cases. Never inject faults into unrelated production work.

For every step record: role/profile, room/channel, intent, actual clicks or tool calls, timestamp, expected result, observed result, artifact/work/message ID, latency, recovery, and whether an external tool was required. Classify evidence as live UI, peer UI report, connector read, worker artifact, local browser test, inference, or untested. Do not substitute one class for another.

## Observed baseline

| ID | Evidence | Finding and consequence | Priority |
|---|---|---|---|
| UX01 | Live human UI + source CSS | Tasks is hidden unless Show advanced agent controls is enabled. New work is also absent from the command search while hidden. Ordinary users cannot discover tracked work. | P1 |
| UX02 | Live UI on both Macs; source inspection | Room chat says Connected while assistant says Fetch is aborted. Successful assistant reads do not clear the stored error; read failures share state with uncertain writes. | P1 |
| UX03 | Live native UI | New work, Settings and Go to dialogs are visually present but their contents disappear from the controller's AX tree. Keyboard input can work. This does not yet establish whether WKWebView, application structure or the controller is at fault. | P1 |
| UX04 | Live human UI | After enabling advanced controls, New work appears but does not open for uuriko. Permission, busy-state and controller targeting need separate reproduction. Do not assume the account is owner. | P1 |
| UX05 | Live agent UI, peer corroboration | Saved Codex identity receives Create an account affordance. Agent identity retention and human guest conversion are conflated. | P2 |
| UX06 | Peer live UI report | Board Add item reported a load failure after the creation succeeded. Repeating the action risks duplicate work. | P1 |
| UX07 | Both Macs' UI observations | Reload returns #test to #general. Navigation continuity and task context are lost. | P2 |
| UX08 | Native UI + peer report | My Mac reports reconnecting; peer reports paused local tools with setup/connect disabled. Chat connectivity does not establish host execution readiness. | P1 |
| UX09 | Live desktop control | Two processes with the same app path cannot be selected reliably by the current controller. Coordinate clicks can select the wrong profile window. Keyboard and menu actions were more reliable. | P1 |
| UX10 | Live worker evidence, independently checked by peer | Fixed repository test completed in 1,646 ms; request-to-answer took 51,387 ms. Local execution speed alone hides dispatch latency. | P2 |
| UX11 | Actual artifact handoff | Artifact hashes and manifest verified on peer, but bytes traveled through Taildrop. Room-native evidence delivery remains unqualified. | P1 |

Live communication: human request 3f965413-9441-4974-8433-2df0ec0e31cd, agent response e4a4e5a0-3fd9-4998-8ee7-4f19c9e518e9, peer marker PAIR-1024-B, peer result 330029d8-05fd-4c2b-b2d4-74f20abdcab0. These are communication evidence, not proof of an autonomous agent loop.

Real work input: human message f26ccbbe-0a09-402d-8ea5-a1975b8976c3 requests these repairs. Codex read it in the agent desktop. Native form filling was attempted; title, done criteria and reviewer were entered but creation was not confirmed. The draft was cancelled without submission; no duplicate task was created. Connector fallback created codex-dual-role-ux-1023 and acquired a scoped code claim. This explicitly fails the UI-only creation criterion.

## Repeated real-work scenarios

| Scenario | Human actions | Agent/laptop actions | Passing evidence |
|---|---|---|---|
| Bug repair | Report a specific reproducible defect; set done criteria; inspect candidate; request a correction | Read linked context; claim exact files; patch isolated checkout; run affected tests; publish diff and logs | One task, exact commit, meaningful test results, correction preserves original request |
| Research/report | Ask a bounded question with source requirements; challenge one conclusion | Gather sources; run local extraction/deduplication; publish source-linked report | Quotes/references inspectable; inference distinguished; updated version keeps history |
| Repository verification | Choose repository/revision and fixed recipe | Dispatch to eligible laptop; execute without a model; return manifest | Exact revision, recipe/package pin, attempt, exit status, hashes, logs, useful summary |
| Cross-laptop work | Request processing while first laptop is occupied | Scheduler selects capacity; second laptop executes; first receives result | Distinct machine identity and real remote execution; no duplicated side effect |
| Review and release | Inspect exact candidate and requested release target | Review diff; check CI on exact head; serialize merge; deploy tested version; smoke-check | Approval attaches to exact version; stale approval refused; rollback reference exists |
| Resume | Leave room, reload, restart app, switch laptop | Resume from durable task cursor and pinned attempt | Same channel/task, no lost draft or duplicate execution; visible last confirmed state |

Run each at desktop and phone width, light/dark, keyboard-only, native AX, and ordinary agent tools. Include an owner human, non-owner human, agent with contribute access and agent with read/chat-only access in local fixtures. Test denied actions by their actual rights, not by changing membership mid-test.

## Fault and boundary matrix

1. Read failure before first assistant projection, then success: clear only read error; restore setup/status.
2. Failed read during an unknown POST: preserve exact request ID and uncertain-action retry. A healthy GET cannot acknowledge a write.
3. Server accepted create but response or subsequent board load lost: resolve saved operation; show the created item link; retry only the read.
4. Two agents claim overlapping paths: one succeeds, the other gets actionable conflict; no silent takeover.
5. Two rooms request one laptop simultaneously: enforce device-wide capacity and avoid starvation.
6. Worker exits before spawn, during spawn, during execution and after result before acknowledgement: release only confirmed stopped work; retain unknown reservations; replay evidence without rerun.
7. Pause/stop before claim and during execution: stop the correct attempt/process group; no late publish after stop wins.
8. Laptop sleeps, network disappears, power/thermal pressure increases: show waiting/unknown, back off, and resume with the same operation. Do not confuse presence with execution.
9. Artifact missing, tampered or denied: no completed-evidence badge; show exact retrieval/verification failure.
10. Role/account switch and expired session: clear old private state; preserve appropriate scoped drafts; never deliver under the wrong account.
11. Ordinary chat, quoted commands and external documents: cannot silently become executable jobs. Typed invocation and authorization remain explicit.
12. Capability upgrade while work is running: old work retains its pin; candidate promotion requires evidence; rollback selects previous package without rewriting past receipts.

## Redesign and implementation order

### Phase 1: make existing work usable and truthful

Restore task navigation for humans while leaving server and action permission checks intact. Keep chat as home; Board and New work support it. Fix assistant refresh error ownership: separate read status from mutation outcome, clear read errors on success, preserve pending-write state. Add regressions in existing browser suites, including phone width. These are the first implemented changes in this branch.

Next resolve UX04 with a fixture of the exact member permissions and busy lifecycle. Show an actionable explanation when work creation is unavailable. Fix saved-agent account copy with role-aware retention messaging. Separate “created successfully” from “could not load board” and give a safe open/reload action. Preserve room/channel/task in navigation state on reload. Reproduce modal AX behavior with a minimal native dialog before choosing a WebKit/application workaround; do not replace every dialog based on one controller observation.

Acceptance: both roles can locate work and understand availability; confirmed reads recover; unknown writes remain explicitly unknown; keyboard and native accessibility reach every critical control.

### Phase 2: join Room to supervised laptop execution

Peer owns host lifecycle integration: reuse existing host, do not install a competing daemon. Expose distinct transport, identity, worker, tool and model readiness plus last successful check and a relevant recovery action. Add a typed capability picker/request form using the durable broker; never accept arbitrary shell text as a recipe. Publish and retrieve artifacts through Room with digest verification. Show end-to-end queue/dispatch/run/publish times.

Acceptance: human starts a fixed verification task in Room, an eligible laptop executes it without an agent turn, and the human opens its artifact in Room. Repeat after lost acknowledgement and host restart with attempt count unchanged where execution already finished.

### Phase 3: agent-native operating surface

Prefer small typed packets and cursor-based deltas over large chat histories. Provide current identity/capabilities, actionable inbox, focused task context, file-scope conflicts, available machine recipes, capacity, and exact-result review as discoverable tools. Batch independent reads and return bounded logs plus artifact references. Offer a compact agent view for debugging these same objects; do not create a second task database. Record tool call counts and payload bytes; estimate tokens only with an explicitly named tokenizer.

Add resume packets, stable business operation IDs, request-to-job correlation, structured error reasons and a “what can proceed now?” query that respects permissions and dependencies. Observe actual model usage separately from deterministic local jobs.

Acceptance: complete the same repair/review flow with fewer unnecessary calls and no full-room replay; recover after an agent restart with no repeated completed operation. Compare baseline and candidate on identical tasks, including failures.

### Phase 4: versioned review, releases and continuous improvement

Connect task, repository, branch, candidate commit, checks, artifact, reviewer decision, merge and deployment receipt. Invalidation follows the exact changed version. Use laptop parallelism for independent tests; serialize shared release state. Add local deterministic failure clustering and reusable recipe suggestions from repeated successful work. Proposals become versioned capability/config packages with evaluations, budget, cooldown, canary and rollback; never silently edit trust roots or promote from self-reported success alone.

Acceptance: a real small change travels request → candidate → tests → review → release → smoke checks with inspectable evidence. A deliberately bad candidate is rejected or rolled back in a local environment. Production release remains governed by its exact-head CI and shared release lane.

## Measurement and release gate

Record task completion rate, blocked step, time to first meaningful action, total time, human interventions, duplicate operations, lost drafts, context bytes, tool calls, actual model usage when available, local execution time, artifact retrieval success and recovery time. Prefer paired runs over unsupported performance claims. Initial targets: no duplicate effects, no wrong-identity writes, no lost acknowledged result, no false “working/done” status, and every failure has a usable next step.

For each slice: reproduce → claim paths → fix in isolated branch → meaningful red/green regression → browser/native check → peer evidence → exact-head CI → serialized release → production smoke. Local test success is not deployment. A simulated human review is not an independent human sign-off. Keep phase completion and individual test outcomes explicit; never mark the whole plan done because one slice passes.

## Current ownership and exit checklist

This Mac owns the two human-experience source files, two browser-check files, this plan, its docs index link, candidate manifest regeneration, and the date-independent claim settlement regression for the first repair slice. Peer retains desktop profile code and host integration; it confirmed it has not edited the UI paths. Wider UI repairs require new exact claims. The native profile window remains a test surface, not a separate autonomous agent process.

Before checkpoint: record checks and candidate commit, link the PR in Room, publish findings through the agent profile, verify the human can read them, cancel the unsubmitted duplicate form, and release claims. Before “Room-only ready”: pass every critical scenario above on both actual laptops with no terminal recovery and Room-native artifacts.

## First repair verification

The stale-read regression failed before the fix and passed afterward. Both browser suites pass (41 tests), including 1280px and 390px task discovery and unknown-write preservation. Affected verification passes (161 tests); lint has zero errors and 290 existing warnings. Candidate manifest regenerated with only the two changed UI asset hashes.

Agent desktop update 57aabc75-4dbb-4b2c-a2ae-5c7f4e11fb5d was visibly received in the Default human profile. The unsubmitted duplicate form was cancelled and the human advanced-controls preference restored to its original off state. This verifies communication and delivery of a work update, not deployment of the fixes or an independent human review.

Contract checks pass. The full Node 24 run completed with 11,486 passing, 4 failing and 31 skipped. The settlement failure reproduced in isolation: its fixed October 16 record aged out of the default seven-day board window. The test now explicitly queries completed history; all 9 settlement tests and all 170 final affected tests pass. Three native-agent-setup login tests still time out in isolation; these were reported to the peer host workstream. The full suite is not green and this candidate is not released.

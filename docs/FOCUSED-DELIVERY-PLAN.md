# Project Room: six-outcome delivery plan

Execution: [evidence-gated build prompt and plan](CONTINUITY-BUILD-PLAN.md); current [work lifecycle build and qualification](WORK-LIFECYCLE-BUILD-PLAN.md) and [canonical work cutover](WORK-CUTOVER-PLAN.md). The latest scope rule applies to every retained item too: previous discussion or implementation is not sufficient justification; retain only supported benefits over simpler alternatives.

2026-10-18. This is the revised active planning scope following the request to cut,
combine and shrink the total backlog. The execution evidence below records actual
progress; the six outcomes remain acceptance criteria. The [773-entry inventory](PROJECT-ROOM-TOTAL-BACKLOG.md)
remains the evidence index, not a promise to build 773 things.

The product test: two people and an authorized agent turn a conversation into an
accepted result, change direction, survive a disconnect, and return without
reconstructing the project or losing control.

## Architecture integration prompt: reconcile with deployed storage

Integrate candidate `93727acb` (#4114) with deployed main `14e4320b` (#4123)
in an isolated checkout. Produce one coherent, testable architecture candidate,
not a mechanical choice of one side of each conflict. Preserve both parents and
their independently useful behavior. Do not deploy, archive live rooms, downgrade
writer fences, or overwrite another lane's source work.

1. Inventory conflicts and semantic overlaps before editing. Map message entity
   ownership, replay snapshots/cursor chunks, legacy-shape repair, operator archive,
   canonical work, privacy purge and recovery to their authoritative modules.
   Record which behavior is retained, combined or superseded and why.
2. Preserve main's bounded replay cursors, version-1 display-name replay,
   audited legacy shape repair, measured storage limits and guarded archive door.
   Preserve the candidate's canonical work repository, exact-evidence acceptance,
   entity-backed message reads, linear replay and fail-closed writer fences.
3. Choose migration order explicitly: opening a schema-38 deployed database must
   reach schema42 without losing cursor state, entities, work facts or audit rows.
   Certification metadata must refer to the same replay snapshot representation.
   Privacy edits and recovery must invalidate/delete every corresponding copy.
   Older writers must remain fenced. Inverse representation conversion is not a
   schema downgrade and must not imply an operator unarchive feature.
4. Resolve source conflicts before generated metadata. Reconcile both parents'
   tests without weakening their invariants; replace obsolete assertions only
   when the new storage contract explains the change. Add a crossing-boundary
   regression using a real pre-integration database when possible: upgrade,
   certification/archive, canonical work, restart and recovery/privacy behavior.
5. Run focused storage/replay/work/archive/migration tests and Worker checks first.
   Regenerate manifests from the integrated tree, verify packaging and lint, and
   then run affected tests and one full Node24 suite after fixes stabilize.
   Report baseline failures separately; no skipped security tests to obtain green.
6. Run the shared room benchmark once on the finished candidate against the pinned
   deployed main, using bodies-at-rest and the documented statistical method.
   Retain slower and inconclusive results. Do not claim productive-user gains
   from microbenchmarks. Verify fixture and measured writes were accepted.
7. Publish the integration as an update to #4114 with the conflict decisions,
   test/benchmark evidence and explicit open gates. Verify remote head and actual
   merge composition. Keep #4118 separate until its base is reconciled; account
   for its follow-up rather than silently dropping it. Release only this source
   claim at the checkpoint, leaving shared deployment roles untouched.

Done means a published integrated source candidate with inspectable evidence and
no unexplained new failures in exercised boundaries. Hosted exact-head checks,
production rollout, physical sleep/wake and the human productivity pilot remain
separate acceptance gates; no local result closes those automatically.

Initial inventory: seven textual conflicts (store, messages-store, Worker package,
generated manifest and three recovery/backfill tests). Main remains schema38;
candidate is schema42. Replay snapshot/cursor composition is a semantic review
requirement even where Git reports a clean merge.

### Integration decisions and evidence (2026-10-18)

The candidate incorporates deployed `14e4320b` and the subsequent copy-only
main update `342f250c`. Snapshot serialization/chunk ownership lives in
`server/message-replay-snapshot.mjs`; cursor metadata stays in
`server/messages-store.mjs`. Large bodies use the deployed chunk format and hash
verification, while independent replay/certification anchors retain linear replay.
Blocked-room diagnosis reads that same snapshot contract, including replay ahead
of certification. Privacy discard deletes the marker and all chunks; small
replacements remove obsolete chunks. Main's legacy-shape repair, v1 name replay,
storage limits and guarded archive route remain present. No retired direct message
writer was restored to resolve an import conflict.

Both parents' regression cases are retained. New boundary tests cover a deployed
schema38 chunked cursor migrating to schema42, Unicode boundaries, corrupt chunks,
transaction rollback and shrinking away private chunks. A separate experiment
created a database using the actual deployed revision, then opened it with this
candidate: chunks migrated unchanged, the old connection could not write, parity
certified, work acceptance persisted, 18 of 20 messages archived, and restart
preserved the archived tail and accepted work. This was synthetic data on disk,
not a live-room archive. Recovery comparison covers 205 application tables.

Qualification results and the full shared benchmark are recorded with the updated
PR #4114. The next source slice remains #4118 after this base is qualified. Its
continuity work, exact-head Linux checks, supported-host sleep/wake, deployment
rehearsal and the human productivity pilot are not silently marked complete by
this integration.

## Active list — six outcomes

## Current execution: work continuity (2026-10-18)

### Next execution: qualify and integrate the existing slice

Finish the existing architecture/continuity candidates before adding features.
This sequence owns the immediate work; it does not replace C1–C8 or count
unmeasured acceptance criteria as completed.

| Step | Concrete task | Acceptance / evidence | Execution status |
|---|---|---|---|
| Q1 | Reconcile PR heads, remote refs, CI results and active release ownership | Every result names its exact revision; stale checks are not reused | Git confirms #4114 baseline repair `93727acb`; initial PR API still reports `b9c4afed`. Release hold remains active |
| Q2 | Integrate local validation tooling with the continuity tree | One existing PR (#4118), no third feature queue; clean merge of baseline repair | Local `4c7678a5` and `93727acb` integrated on the qualification branch |
| Q3 | Finish the cheap preflight contract | Missing imports/new uncovered server modules refuse before workers; abnormal child termination fails; generic dependency checker stays reusable | Complete: shared package verifier plus manifest-drift gate; refusal/termination subprocess tests pass |
| Q4 | Freeze runtime/tooling edits and qualify once on Node 24 | Focused failures fixed first; affected tests, lint, package checks, CI-mode checks and one full suite; exact baseline failures retained | Complete locally: 11,126 pass / 24 exact baseline failures / 8 skipped; lint and contract checks pass. Earlier manifest failure repaired and rechecked |
| Q5 | Publish the same tested tree to #4118 | Updated PR scope, full qualification evidence, clean source checkpoint and release-owner handoff | Source checkpoint qualified for #4118; published head and live CI tracked on the PR. No force push or policy-role release |
| Q6 | Land and qualify the supported product journey | Exact required CI, coordinated merge/release, production smoke, physical sleep/wake and comparative pilot evidence | Separate open gates; automation cannot substitute for physical/human observations |

Development loop: preflight first, focused tests while changing code, then one
full run after the code stops changing. Metadata/documentation updates do not
justify rerunning unrelated expensive experiments. A new failing invariant or
runtime change does. Compare CI to the candidate's merged tree as well as its
head so generated-baseline conflicts are found before another CI queue cycle.
Keep a published candidate separate from production status and never interpret
queued checks or absence of a result as approval.

The preflight checks installed dependencies, existing module-coverage rules and
all allowlisted runtime imports and candidate-manifest drift. It warns about Node-major differences from CI,
does not install or switch runtimes, and leaves cold-package and full-suite
qualification intact. The Node engine range remains unchanged.

This section owns the next concrete tasks; the six outcomes below remain the scope.
The release candidate is PR #4114; `93727acb` preserves the existing fresh-base i18n ratchet, and `b9c4afed` adds direct storage-module tests to
repair the coverage gate at `0ddf0908`, without changing its runtime. New continuity
work is isolated on `codex/work-brief-continuity-20261018`. Final local qualification is recorded in [validation evidence](work-brief-validation.json).

| Task | Feature / work | Completion evidence | State |
|---|---|---|---|
| C1 | Finish #4114 exact-head CI, qualify merged revision, release and smoke-test | Required checks, deployed SHA, workflow and data continuity smoke | Waiting on hosted CI and shared RELEASE-PAUSE; no merge/deploy |
| C2 | Trace work context, preparation, interruption, result and acceptance ownership | Existing interfaces mapped; missing contracts identified | Audited: selectedWorkContext owns reads; work-preparation composes them; private cache owns discussion continuation; work-actions owns revision-fenced commands |
| C3 | Derive a compact versioned work brief from existing authorized context | Stable content version, explicit omissions/provenance, stale-change classification and privacy tests | Implemented; synthetic freshness/privacy tests pass |
| C4 | Connect the brief to selected-work reads and resumable preparation | Same version in MCP brief and private resumed output; restart and permission-change tests | Implemented; MCP preserves compact Markdown and adds only a digest; CLI --brief skips discussion |
| C5 | Bind execution observations to the brief used; surface stale context on return | Real supported-host interruption/redirect/result journey; no duplicate effect, changed context visible | Exact input digest and optional work-brief version journaled atomically before runtime start. Linked-work request adapter tested; real native model + journal reopen passed. Physical sleep/wake and complete user pilot remain open |
| C6 | Make the existing human result/return view expose relevant freshness and next action | Browser test for review, changed requirements and resumption; keyboard/mobile checks | Reused existing stale-draft, work-change and handoff surfaces; 9 desktop/mobile browser checks pass. No redundant new UI added |
| C7 | Compare minimal, selected and broad context on representative tasks | Reproducible task inputs, correctness/recovery/bytes/cost results; human-effort claims require human trials | Payload/freshness qualification implemented: 123 / 4027 / 65850 bytes. Model-quality and independent-human comparisons remain unmeasured |
| C8 | Integrate continuity, remove superseded paths and verify production journey | Exact-head qualification, coordinated merge/release, evidence ledger and residual limitations | Pending; depends on C1 and C3–C7 |

The #4114 repair directly exercises batched entity hydration and corrupt/missing
entity refusal, archived/live cursor ordering and viewer filtering, replay
migration preservation, idempotent migration and transactional rollback. It does
not loosen the coverage gate or extend its grandfather list.

The brief is derived data, never a new authority or semantic summary. It must not
fetch arbitrary evidence links, include private conversations, infer acceptance,
or claim that a digest is a signature. References retain their source identifiers.
Unrelated room activity should not invalidate the brief, while task, charter,
authority and result changes must. Reading a brief does not authorize execution.
Physical sleep/wake remains a separate unfulfilled hardware qualification.

Release coordination: live muse-room confirms an active non-expiring RELEASE-PAUSE.
The default connector is bound to build-together; the existing own identity was
used explicitly against muse-room to verify the source lease
`codex-work-brief-continuity-1018`. No other agent's identity or release role was used.

### Continuity feature usage and limits

`node scripts/agent-work-preflight.mjs PRIVATE_CONNECTION_DIRECTORY WORK_ID --brief`
returns only the selected work brief. `--resume` retains the existing private
discussion continuation and includes a fresh brief. Neither mode starts work.
`client/work-brief.mjs` exports `createWorkBrief` and `compareWorkBriefs`; changed
sections identify requirements, authority, instructions, progress, evidence,
source metadata or linked conversations. Same-version observations are not proof
that omitted conversation or externally linked evidence is still current.

MCP's existing `brief: true` response adds `briefVersion` without duplicating the
structured brief alongside Markdown. A regression test caught that duplication
making the compact response larger than selected context; the output was fixed
and the original size assertion retained.

The native runtime journals only the exact input digest, byte count and optional
brief version, not another copy of private prompt text. `contextObservation(binding)`
requires current authorization; legacy attempts report unavailable observations.
The addressed-request runner fetches a fresh authorized brief for linked work,
but a conversation association never grants work-transition authority.

Reproduce synthetic payload/freshness checks with
`node scripts/qualify-work-brief.mjs /absolute/report.json`.
[Measured fixture](work-brief-qualification.json) and
[real native-host qualification](work-brief-native-host.json) distinguish what was
measured from the outstanding productivity study. The measured 94% payload reduction
compares the synthetic selected brief with the broad context fixture, not complete
MCP envelopes, model quality, execution latency or human productivity.

The [shared room benchmark](work-brief-room-bench.json), run once against
`0ddf0908` with 1,000 messages and bodies at rest, classifies every metric as
inconclusive (`~`). This is not evidence of either a speedup or equivalent
performance; write p95 moved from 5.79 to 8.02 ms with wide intervals. Preserve
the full table in the continuity PR. The room benchmark does not measure native
runtime journal overhead or model reasoning quality.

| ID | Outcome and bounded scope | Finish condition |
|---|---|---|
| F1 | **Finish the core overhaul.** One owner for each domain and execution transition; canonical message/work/attempt/artifact records; narrow commands and repositories; shared authorization; transactions and due-effect intent. Migrate existing data and remove replaced writers, serializers and callers. | A normal change does not require unrelated central-file edits; tested migration/restore works; no competing writer or permanent compatibility layer remains in the changed scope. |
| F2 | **Make work survive interruption.** One durable scheduler and attempt/effect journal; revision fencing, idempotency, truthful stop/redirect, reconnect and unknown-outcome reconciliation. Integrate one supported Mac host path using existing work. | A real task survives sleep/crash/reconnect, respects a changed request, cannot duplicate a known effect, and exposes unreconciled outcomes honestly. |
| F3 | **Give every task the right context and a reviewable result.** Compact versioned context from existing Room sources, bounded agent reads, source-linked artifacts, evidence freshness and one review packet. Use existing result viewers first. | A fresh participant can understand, verify, correct and continue the task without reading the whole conversation; stale evidence is visible. |
| F4 | **Make the complete human journey usable.** Join/sign-in, conversation, task handoff, feedback, draft/attachment recovery, review and return; contextual controls, honest availability, keyboard and mobile usability. | Two people and an agent complete the product test on supported surfaces without a broken door, lost draft, misleading completion or inaccessible required control. |
| F5 | **Prove a useful advantage.** Fix measured bottlenecks and collect four primary measures: accepted outcomes per human hour, elapsed time to acceptance, seven-day rework, and total cost per accepted outcome. Keep privacy/correctness/accessibility as non-tradeable gates. | A reproducible pilot comparison reports benefits and uncertainty at acceptable quality/cost; ordinary operations do not scale with unrelated history. No universal speedup claim from a microbenchmark. |
| F6 | **Integrate, release and retire.** Reuse or replace existing candidates, establish a supported green baseline, qualify the combined tree, rehearse backup/restore and rollback, remove obsolete paths, and verify the shipped journey when release is authorized. | Exact candidate and deployment evidence, successful recovery rehearsal, no known unresolved critical security/data-loss issue in supported scope, and explicit residual limitations. |

F1 and F4 can advance together against agreed contracts. F2 depends on F1's
execution/storage contracts. F3 builds on those contracts and connects to F4.
F5 instrumentation starts immediately and comparison follows a usable slice.
F6 integration discipline starts immediately; its final gate follows F1–F5.
Keep at most two implementation slices active and one shared integrated candidate.
This is a work-in-progress limit, not permission to start extra agents.

## Actual reductions

### Remove from the current delivery commitment

- A general self-improving orchestration platform, automatic model/tool generation,
  and speculative multi-agent execution. These are research options, not foundations.
- Collaborative CRDT editing, arbitrary interactive apps and a new document editor.
  Deliver versioned results, targeted feedback and existing viewer integration first.
- A broad local knowledge index and universal project memory. Use explicitly linked
  Room evidence and scoped direct reads first; add indexing only for observed retrieval gaps.
- Broad connector/environment expansion. Support the existing interfaces and one
  complete Mac host workflow before increasing the compatibility matrix.
- Optional Mac menu-bar polish, Spotlight, AppIntents, multiwindow, voice, closed-app
  push and capture expansion. Preserve required native security and recovery tests.
- Commerce/public-marketplace expansion, pricing guidance, contribution scoring,
  semantic calendars, meeting automation and generated task dashboards.
- A standalone automation product. Keep deterministic recovery, evidence freshness
  and review-packet preparation inside the existing work lifecycle.
- A large ongoing benchmark/research bureaucracy. Run experiments attached to a
  concrete failure or bottleneck, with a baseline, budget and decision.

These are deferrals or rejected *release requirements*, not deletion of user data,
existing contracts, security repairs, financial obligations or historical ideas.
Existing public-work/commerce surfaces still need privacy, correctness and recovery
repairs; F6 must triage those findings before judging the candidate releasable.

### Conditional architecture work

Per-room placement migration, advanced incremental views, more elaborate replay
engines and additional services are not automatic release prerequisites. Preserve
single-authority and bounded-storage contracts now. Activate the larger implementation
only if the chosen pilot's measured concurrency, recovery, fairness or storage limits
cannot be met with the simpler supported deployment. Record the actual trigger and
failed simpler option. This explicitly narrows A5/R1/R2's unconditional scheduling;
it does not mark those ledger entries complete or remove their safety requirements.

### Stop doing

- Treating every issue, PR or historical proposal as an independent feature promise.
- Exhaustive historical reading as a prerequisite to every implementation step.
  Reconcile sources affecting the current boundary first; retain unknown coverage.
- Opening new research tracks while an existing implementation lacks integration.
- Repeated local micro-optimizations without checking complete workflow impact.
- Cosmetic file splitting that leaves authority and dependency coupling unchanged.
- Maintaining several competing active roadmap documents. This plan owns active scope;
  earlier documents provide acceptance detail where retained and historical rationale
  where deferred. A deferred scope cannot silently return through an older checklist.

## What combines into what

| Existing scope | Disposition |
|---|---|
| ARC, MSG, DAT; A1/A2/A2.1/A3 | F1; preserve local qualified evidence, finish remaining cutovers and retirement |
| EXE, SCH; A4/R3/R4; required MAC recovery | F2; one lifecycle, scheduler and journal rather than multiple recovery systems |
| CTX, API, ART; P1/P2/P4 | F3's compact context and reviewable-result slice; advanced indexing/editing/tools deferred |
| UI, required MAC/SEC/WRK behavior | F4 plus F1/F2 policy; ship complete supported journeys |
| PERF, MET, PRO; M1/M2/R5 | F5; four primary measures, diagnostic metrics only when needed |
| COV, ENG, OPS; G1/A7/P3 | F6 and per-slice qualification; source records are evidence rather than additional products |
| AU1–AU6 | Inventory only relevant existing automation; recovery in F2, freshness/review in F3, regression prevention in F6; other automation deferred |
| AD1–AD4, RES, novel features | Deferred research pool; ordinary versioned telemetry/evidence retained, adaptive platform deferred |
| ISO/A5, R1/R2 | Conditional experiments/implementation triggered by measured supported-workload limits |
| GH issues/PRs | Triage evidence, not 403 delivery outcomes; see rules below |
| 48 Mac checks | Required supported-path acceptance under F2/F4/F6; optional-feature checks inactive until that feature enters scope |

## Brainstorm dispositions

Use four ideas as small acceptance/design requirements, not standalone systems:

- I01 commitment preservation: source IDs and explicit scope decisions in the backlog;
  no new intent-compiler product.
- I10 forgetfulness testing: a fresh-agent continuation test in F2/F3.
- II01 bottleneck optimization: inspect review/coordination queues in F5 before adding capacity.
- III12 project reality view: accurate state/evidence labels in F3/F4, not another dashboard.

The other 30 proposals remain in the research pool. Their principles may inform an
ordinary implementation, but they do not authorize additional feature work.
Reopen an idea only with an observed failure or repeated need, a baseline, a small
experiment and a decision about what active work it replaces or simplifies.

## Important additions to the smaller plan

1. A single acceptance story shared by architecture, UX, agents, native and release.
2. An explicit supported-path matrix: client, host, environment and failure behavior.
   Unsupported combinations must be named, not implicitly promised.
3. A deletion/retirement gate in each architectural slice; migration alone is not completion.
4. An integration/WIP limit so another collection of qualified but disconnected branches
   cannot masquerade as progress.
5. A scope substitution rule: new noncritical work must replace, simplify or demonstrably
   unblock active work. Security/data-loss findings can interrupt, with the displaced work recorded.

## How to handle the 403 GitHub entries

Keep their IDs and source records. During reconciliation assign each to one of:

- Required fix/acceptance evidence for F1–F6.
- Already satisfied; verify on the actual integrated revision.
- Duplicate/superseded; select one implementation and retain the source links.
- Existing out-of-focus obligation needing maintenance/security repair.
- Deferred feature or experiment, with a reopen condition.

Read bodies, review objections, changed heads and exact code before an individual
closure/merge decision. The current title inventory cannot justify bulk closure.
Bundled vulnerabilities and data-loss findings must be split and assessed; they do
not disappear because their parent workstream is deferred. No issue/PR is closed
by this scope document.

## First execution slice

Finish the canonical message read/write boundary on the reconciled current candidate:
reader/caller census, atomic entity/event/effect writes, privacy/order parity, migration
and recovery, then remove superseded serialization. Attach the existing user send/edit/
return journey and a fresh-agent read to that slice. Baseline first, exact-tree evidence
at completion. This advances F1, F3 and F4 without starting three independent products.

## Current execution: continuity on the reconciled architecture

Integrate PR #4118 `d611d138` with qualified architecture source `aa69cf95`.
Preserve both histories and every retained C1–C8 acceptance task. Resolve planning
text by retaining both execution records, regenerate the manifest from the combined
package, and inspect runtime-package unions for dropped modules. Do not change the
storage behavior already qualified on #4114 or expand into new feature lanes.

1. Check #4114 exact-head hosted results and diagnose new failures if any. Keep
   pending checks explicit; a clean merge is not hosted qualification.
2. Merge the new base, run preflight and focused brief/cache/preparation/native
   runtime/packaging tests, then lint and affected checks against the actual stacked
   base. Run the required full suite once after the merge is stable.
3. Preserve context version/omission semantics and exact runtime input provenance.
   Verify new base modules remain packaged and bounded snapshot migration tests
   still pass. Use existing source-identical performance evidence where justified;
   do not repeat a benchmark merely to replace inconclusive results.
4. Publish the refreshed #4118 head and source-bound qualification. Explain the
   stacked diff and its large-diff justification. Keep #4114's hosted gate separate,
   and leave production release and physical sleep/wake unclaimed.

Continuity integration checkpoint: #4118 includes architecture `aa69cf95`; only
planning text and the generated manifest conflicted. 51 focused tests pass. Full
Node24 qualification: 11,174 passed, 24 exact recorded Mac host failures, 8 skipped.
The affected run found nine baseline host failures and a fixed-delay relay-test
failure; replacing that delay with the existing bounded wait produced 17 passing
machine tests. Lint has zero errors. Server/Worker/browser source and Room benchmark
code are unchanged from #4114; its performance evidence is reused with that scope,
not represented as another measured speedup. Current main's later `f18cd508`
escrow/heartbeat change remains outside this pinned stack. Exact-head hosted checks,
release reconciliation, sleep/wake and the human pilot remain open.

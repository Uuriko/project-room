# Project Room: six-outcome delivery plan

Execution: [evidence-gated build prompt and plan](CONTINUITY-BUILD-PLAN.md); current [work lifecycle build and qualification](WORK-LIFECYCLE-BUILD-PLAN.md) and [canonical work cutover](WORK-CUTOVER-PLAN.md). The latest scope rule applies to every retained item too: previous discussion or implementation is not sufficient justification; retain only supported benefits over simpler alternatives.

2026-10-18. This is the revised active planning scope following the request to cut,
combine and shrink the total backlog. It changes scope, not implementation status.
The [773-entry inventory](PROJECT-ROOM-TOTAL-BACKLOG.md) remains the evidence index,
not a promise to build 773 things. No issues/PRs were closed and no runtime was changed.

The product test: two people and an authorized agent turn a conversation into an
accepted result, change direction, survive a disconnect, and return without
reconstructing the project or losing control.

## Active list — six outcomes

## Current execution prompt: reconcile architecture with deployed storage

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

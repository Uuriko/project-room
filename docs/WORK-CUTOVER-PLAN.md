# Canonical work and acceptance cutover

Baseline `ee32e58f`, 2026-10-18. Implements the remaining boundaries in
[the lifecycle plan](WORK-LIFECYCLE-BUILD-PLAN.md).

## Contract

Work items own task completion evidence, exact-result verification, human decisions
and revisions. Board claims own execution reservations and delivered bundles.
For an item-backed claim, board state is not authority to accept the work item.
Keep board-native tasks compatible; never manufacture signed evidence or attribute
one actor's approval to another. Item-backed actions must reach the existing work
command validator, including current credentials, permissions and revision fences.

## Sequence

1. Enumerate raw projection reads and every serializer caller, including deletion,
   public publication, identity cleanup, replay, checkpoints and board backfill.
2. Build a work-record repository that preserves each complete aggregate exactly,
   with room/id/revision/content identity. Store references in the room carrier;
   hydrate through the existing projection boundary. Keep historical checkpoints
   self-contained. Missing/mismatched references fail closed.
3. Persist changed records and the carrier in the same caller transaction as the
   event and command receipt. Unchanged work does not rewrite its payload. Retire
   replaced payload versions only in that transaction. Fence older writers.
4. Add atomic conversion/comparison and inverse reconstruction. Qualify interruption,
   rollback, reopen, stale revision, cross-room references and privacy redaction.
   Keep legacy inline reads for migration; never give inline and entity records
   independent authority in the same room state.
5. Route item-backed board acceptance through canonical work commands, or point to
   the canonical action when the board form lacks required evidence. Do not map
   arbitrary board bundles to signed work receipts. Test both doors, permissions,
   retries and send-back against exact evidence.
6. Measure binding bytes and one-item mutation cost with unrelated tasks/history.
   Distinguish eliminated payload rewriting from remaining reducer/hydration cost.
7. Qualify the integrated candidate: affected tests, lifecycle/recovery/Worker tests,
   real board/resume browser journeys, lint and docs. Record remaining limitations
   precisely; no production deployment is part of this local implementation.

## Rejected shortcuts

- Claim rows cannot absorb work records without losing roles, DoD and evidence.
- A second mutable task table plus a full mutable room copy is not a cutover.
- A view that reconstructs the entire room for every mutation hides the same cost.
- A board approve is not a signature, independent verification or owner decision.
- A smaller stored row alone does not establish constant-time commands.

## Evidence and status

The local implementation now stores canonical work payloads separately, checks
reference content identity on hydration, persists only changed payloads, and routes
item-backed acceptance through the existing work authority. Board-native tasks retain
their separate contract. This is not a claim that all architecture work is complete.

## Next delivery chunk and v1.0 path

Finish this cutover before adding the approach-review feature. It is the current
critical path to F1/F3/F4: one accepted result must mean the same thing on every
surface and survive restart. Execution order:

1. Repair acceptance routing and pending-review labels; test native board behavior
   separately from item-backed behavior so neither can bypass its authority.
2. Complete payload integrity, cache accounting, deletion, transactional failure,
   restart and reversible migration checks. Keep rollback on the schema42 runtime;
   reopen with workEntities:false after inverse conversion. Older writers remain fenced.
3. Compare inline/entity storage on the same synthetic workloads. Publish bytes
   and timing, including regressions; do not equate smaller writes with O(1) commands.
4. Run affected, browser, Worker, lint and documentation qualification. Fix failures
   before calling this slice complete. Commit the exact local candidate.
5. Gate v1.0 on the six existing outcomes, not the historical brainstorm inventory:
   one supported human+agent journey, interruption recovery, scoped context, truthful
   review, permissions/privacy/accessibility, and a restore/release rehearsal.
   Mark any unproven outcome open with a next test; local success is not deployment.

Approach review is retained as a bounded follow-up: explicit human correction and
repeated failure trigger a short evidence/alternative/decision/check record in the
existing work lifecycle. No separate adaptive platform. It earns expansion only by
reducing acceptance time, cost or human rescue without increasing rework.


## Measurement and tradeoff

[Reproducible storage comparison](work-storage-cutover-results.json): Node 24.19,
local SQLite, 12 samples after two warmups, fixed-head work.blocked command.
Run `BENCH_WORK_STORAGE=inline node scripts/benchmark-work-boundaries.mjs 100 400`
and then the same command without BENCH_WORK_STORAGE. Modes were sequential;
results are indicative, not statistically established production speedups.

| Unrelated work | Inline → entity carrier bytes | Command binding bytes | Median command ms |
|---|---|---|---|
| 100 | 63,104 → 13,428 | 144,292 → 33,491 | 3.983 → 4.821 |
| 400 | 249,404 → 51,828 | 561,292 → 118,691 | 11.471 → 9.784 |

The 400-task case binds 78.9% fewer bytes; the smaller case is slower. Retain the
boundary for canonical ownership and elimination of unrelated payload rewrites,
not a universal speed claim. Total hydration/hashing, carrier references and board
synchronization remain linear. A targeted-work command boundary remains open under
F1/F5; optimize it against an end-to-end workload, not by dropping integrity checks.

## v1.0 critical path after this checkpoint

The existing six-outcome plan remains the only active scope. No speculative feature
is newly required for v1.0. The shortest justified route is this ordered release gate:

| Gate | Evidence now | Remaining release requirement |
|---|---|---|
| Canonical result and data survival | Work repository, rollback/reopen, acceptance route and migration checks in this slice | Reconcile this isolated candidate with the selected main revision; qualify combined privacy/recovery and retire any remaining competing writers in supported flow |
| Complete supported journey | Local browser board/resume and HTTP exact-evidence acceptance | One documented human + authorized agent task on the supported Mac host, including real sleep/disconnect, redirect, reconnect and review |
| Truthful execution | Prior lost-response/restart trial proves existing idempotent retry; no new retry coordinator justified | Show unknown external outcomes honestly and reconcile them before retry; physical-host behavior remains unproven |
| Human usability | Desktop/narrow viewport, keyboard and axe coverage | Exercise join/sign-in, draft recovery, scoped access and result correction together; record supported/unsupported surfaces |
| Useful advantage | Lower storage binding bytes, prior continuity gains | Measure acceptance time, human effort, cost and rework on comparable real tasks; no world-best claim without evidence |
| Release and recovery | Local schema42 migration/reversal and fenced writers | Exact integrated candidate, green release gates, backup/restore rehearsal and authorized deployment with post-release smoke checks |

Do not estimate a completion date from test counts. Finish one supported vertical
journey and its failure paths, close critical defects, and then authorize release.
Historical connector, editor, marketplace and generalized adaptive-platform ideas
remain deferred. The bounded approach-review follow-up does not block v1.0 unless
we demonstrate a supported journey cannot be completed reliably without it.

## Remaining architectural limits

- Full aggregate hydration and room-carrier serialization still occur. This slice
  eliminates repeated work payload storage, not all room-wide CPU or writes.
- Execution reservations and canonical acceptance have explicit different owners;
  old independent board deliveries remain preserved and diagnosed, not silently
  rewritten into canonical approvals. Legacy divergence requires review at integration.
- Inverse conversion is supported on schema42 with workEntities:false. It does not
  downgrade the writer fence or authorize an older binary to write schema42.
- Interrupted multi-room conversion is safe per room. Re-run migrateWorkProjections
  explicitly to finish any inline rooms after interruption; mixed carriers remain readable.
- Production data, real agent productivity and physical Mac sleep/wake are not
  exercised by local tests. No deployment was performed. The shared benchmark table was posted to muse-room at John’s explicit request.

## Shared benchmark and peer review

Used [the shared benchmark](BENCH.md) from PR #4101, exact head `20731c42`.
Retrieved code drop `cd-7ecd9dea2554` from muse-room and verified its full SHA-256
against metadata. Read the harness/statistics implementation; its four statistics
tests pass. Review notes posted with the table: dirty metadata omits untracked
files and safe metric wrappers can turn runtime failures into n/a, so record
source hashes and preserve failure reasons before treating n/a as an absent API.

Command: `npm run bench:room -- --base ee32e58f --sizes 1000 --out docs/work-cutover-shared-bench.json`.
One run with the default six alternating samples per side; no repeat for a favorable
verdict. [Raw samples and measured-file hashes](work-cutover-shared-bench.json).

Room-scale benchmark · head ee32e58f+changes vs base ee32e58f (ee32e58f)
6 runs per side, alternating, fresh process each · 200 writes per run · bodies inline · Node v24.19.0 · Apple M5 (10 cores)

Room of 1000 messages
| metric | base median [95% CI] | head median [95% CI] | head/base | p (Holm) | verdict |
|---|---|---|---|---|---|
| write p50 (ms) | 4.65 [4.12–7.60] | 4.66 [4.32–5.41] | 1.00x | 1.000 | ~ |
| write p95 (ms) | 8.49 [7.44–12.61] | 8.31 [8.02–9.24] | 0.98x | 1.000 | ~ |
| storedProjection (ms) | 0.87 [0.75–1.26] | 0.84 [0.73–0.96] | 0.97x | 1.000 | ~ |
| cold room() (ms) | 1.81 [1.37–1.99] | 1.61 [1.25–1.74] | 0.89x | 1.000 | ~ |
| projection (KB) | 1211 [1211–1211] | 1211 [1211–1211] | 1.00x | 1.000 | ~ |
| snapshot build (ms) | 2.71 [2.19–3.11] | 1.87 [1.55–2.15] | 0.69x | 0.017 | **better** (31% less) |
| GET full room (KB) | 1323 [1323–1323] | 1323 [1323–1323] | 1.00x | 1.000 | ~ |
| GET full room (ms) | 8.00 [6.28–10.23] | 6.39 [5.60–7.68] | 0.80x | 1.000 | ~ |
| GET recent window (KB) | 221 [221–221] | 221 [221–221] | 1.00x | 1.000 | ~ |
| GET recent window (ms) | 4.46 [3.68–4.80] | 4.02 [3.81–4.63] | 0.90x | 1.000 | ~ |
| replay from log (ms) | 105 [91–124] | 93.0 [84.0–119.0] | 0.89x | 1.000 | ~ |

Verdicts need a Holm-adjusted p < 0.05 across this size's metrics and a move of 10% or more. Under 6 runs, intervals span the full range.

This fixture has messages, not work items. It measures collateral message-path
cost, not work-entity scaling. Snapshot build is the only statistically significant
win in this run; causality is not established. All other metrics are inconclusive,
not proof of equivalence. The v41 writer-function compatibility repair followed
this measurement; the measured candidate is explicitly recorded in the raw report.

Posted the complete table as muse-room message `work-cutover-shared-bench-20261018`,
replying to `code-cd-7ecd9dea2554`; readback confirmed the message and table.
Event receipt: `e0bfe538-a40c-40e0-956a-fce93f693588`.

## Checkpoint qualification

[Exact qualification report](work-cutover-qualification.json), after the migration
and package repairs:

- Full `npm test`: 11,099 pass, 27 fail, 8 skip (11,134 total). Every failing test
  name was reproduced on exact base `ee32e58f` in this environment. No additional
  failure remains in this candidate. This is not a green release gate.
- The 27 baseline failures concern the Linux-only isolated host and Mac temporary
  path assumptions in coverage, bridge and invariant tooling. Keep the sandbox
  fail-closed; qualify on the supported host before release.
- Final browser + Worker journeys: 14 pass, zero fail, covering board keyboard
  focus, linked acceptance, reconnect/resume, message continuity and schema migration.
- Lint: zero errors, 290 existing warnings. Documentation: 579 checked links,
  zero broken; diff whitespace check passes.
- Earlier affected run: 2,007 pass across 312 files. The later full run above is
  the stronger check for the final code; no claim that the earlier run was exact-final.

Repairs found by the broader run include the missing retained v41 writer function,
runtime allowlisting of the new repository, schema42 cold-package compatibility,
and fixtures that previously treated raw carrier references as work payloads.
Recovery's complete table comparison now includes canonical work rows. Purge
registration also includes the existing message replay snapshot sidecar.

The candidate is locally checkpointed, not merged or deployed. Next work is to
integrate against the chosen main revision and close the supported-host/recovery
release gates above. Do not add the brainstorm backlog to v1.0 by default.

The next execution plan is [integrated candidate and recovery qualification](WORK-INTEGRATION-PLAN.md).

# Build prompt and evidence-gated execution plan

2026-10-18. Implements the six-outcome direction subject to the user's latest
constraint: every proposed and existing mechanism must justify its continued
cost. Historical plans are hypotheses and evidence, not automatic obligations.

## Concrete execution prompt

Build Project Room into a demonstrably better place for two people and an
agent to complete shared work through requirement changes and interruptions.
Inspect the current implementation and relevant earlier evidence before adding
anything. Reuse correct mechanisms; replace or remove mechanisms whose benefit
does not justify their complexity. Keep canonical authority, privacy, durability
and explicit user control. Do not confuse a local test with production success.

For each proposed slice, record the user failure or measured architectural cost,
the simplest alternative (including doing nothing/deleting), expected benefit,
cost and independent acceptance test. Implement only justified slices. First
establish a failing case or baseline, then change the smallest coherent boundary,
test real persistence/restart/refusal behavior, and measure the result. Retire
replaced paths where the evidence permits it. Update the plan from results.
Do not add features merely because earlier discussion mentioned them. Do not
restart a broad research program or create a competing context/state subsystem.

## Admission rule

A candidate must name: (1) observed problem, (2) affected user/operation,
(3) cheaper alternative, (4) testable benefit, (5) correctness/security obligations,
(6) maintenance and migration cost, (7) stop/removal condition. Choose the strongest
supported option, not an unprovable claim of absolute optimality. Existing designs
face the same test. Safety and data-integrity repairs are mandatory when a concrete
finding establishes the need; speculative architecture is conditional.

## Decisions at the reconciled baseline

Main `470d546a` is merged into the existing architecture branch (`f1948f32`).
The import conflict retained main's patrol blocking support and this branch's
repository visibility helper. Merge is local, not deployment qualification.

- **Reuse** selectedWorkContext and existing restart-safe client context caching.
  They already connect current work, evidence, permissions, omissions and next steps.
  A new continuation database or giant context record is rejected as duplication.
- **Test and implement** transaction-local archived-message command preparation.
  Current admission writes an intermediate room projection and then writes the
  accepted result. Indexed entity hydration already exists, so retaining SQL
  restoration adds serialization and write coupling without adding durability.
  Cheaper alternative: retain the existing reducer and load its required entities
  into an ephemeral room context, persisting only the accepted transition.
  Acceptance: zero preparatory projection writes; same semantics, privacy,
  idempotency, rollback, entity certification and restart/reversal behavior.
- **Retain provisionally** the existing reducer and bounded migration carrier.
  They preserve established semantics. This slice does not justify claiming full
  aggregate cutover or removing unqualified compatibility/recovery paths.
- **Measure** continuation using real command/read/cache boundaries and deterministic
  fault scenarios. No new benchmark framework, model calls or public-service load.

## Delivery sequence and gates

1. Reconcile relevant code and main; write this prompt; capture baseline tests and
   archived-edit query/byte/latency measurements on the merged baseline.
2. Make archived references transaction-local. Reuse entity/provenance validation;
   preserve deletion authority, ancestor visibility and corruption fallback.
   Demonstrate an intended failing regression before implementation.
3. Qualify posts/replies/edits/polls/pins, source-linked work/decisions, rejected
   commands, duplicate commands, rollback, restart, legacy fallback and redaction.
   Remove the superseded preparation-write path after these checks pass.
4. Exercise current work continuation with a changed requirement, service/client
   restart and source correction/revocation. Add behavior only for demonstrated gaps.
   Keep exact request/command replay distinct from new intentional work.
5. Compare baseline/candidate query and byte counts and latency under identical
   fixtures. Run affected platform/packaging and integration tests appropriate to
   changed boundaries. Record failures and limits; do not sum overlapping suites.
6. Continue the next justified boundary: independent work/attempt/artifact writes
   or a demonstrated continuation failure. Do not automatically implement all
   deferred ideas. Full release still needs complete integrated qualification,
   supported human/native journeys and current release authorization.

## Product acceptance experiment (subsequent integrated gate)

Choose real repository tasks with externally checkable outcomes. Compare current
Room, rebuilt Room and a competent same-model/tool workflow outside Room. Keep
model/tool versions and budgets fixed; counterbalance task families; include setup,
reading, review, correction and recovery effort. Separate training/debugging cases
from held-out tasks. Independent reviewers assess acceptance and later rework.
Use pilot variance to choose sample size rather than inventing significance.

Primary measures: accepted outcomes per human hour, elapsed time to acceptance,
seven-day rework and total cost per accepted outcome. The 2x productivity and 80%
less reconstruction-effort targets are aspirations to test, not release facts.
Authorization, data integrity and required accessibility cannot be traded for speed.

Supported-path matrix and real Mac/browser proof must precede a release claim.
No new agent enrollment, paid model run, external effect or deploy is implied by
this local implementation plan.

## Execution evidence

- Integrated current main locally at `f1948f32`, preserving patrol-block support
  and the architecture branch's visibility helper.
- Two regression checks failed on that baseline: one intermediate projection write
  and preparation changing the serving projection. Both pass after replacing the
  SQL restoration helpers with transaction-local entity hydration.
- Removed the two SQL-writing single/reference restoration entry points and their
  shared write path. Full archive reversal remains because it serves a distinct,
  tested migration purpose. Entity provenance and legacy replay fallback remain.
- Message/archive suite: 75 pass. Work-context/cache/action plus merged patrol and
  identity-binding suites: 43 pass (before adding the lost-response case).
- Lost-response/restart/action-boundary suite: 3 pass. The new scenario drops a real
  HTTP response after a 201 commit, restarts the service, advances the work, then
  retries the original operation. It verifies the original receipt, no duplicate
  event, no rewind and refusal of changed retry input. Existing runtime already
  passes; adding another recovery subsystem is unjustified by this evidence.
- Workers SQLite message-continuity and fidelity checks: 2 pass.
- [Raw before/after measurement](continuity-command-context-results.json) records
  runtime, source hashes, samples and query profiles. At 10k history, reference
  mode uses 21 rather than 22 prepared statements and 2,415 rather than 9,792
  serialized binding bytes (75.3% less). In inline entity mode bytes fall from
  15,984 to 8,607 (46.2%). No physical-WAL or production improvement is claimed.
  At 1k reference-mode median latency worsened slightly; at 10k it improved.
  Keep the simpler write boundary for structural cost reduction, not a claimed
  statistically established speedup.

The overhaul is still incomplete: this removes preparation writes, not all
message projection serialization or independent aggregate writes. No real-model
productivity study, physical Mac interruption exercise, or deployment was performed.
Broad qualification results are recorded below when completed.

## Decision record for this checkpoint

| Candidate | Decision | Why / evidence that would change it |
|---|---|---|
| New continuation/context subsystem | Reject | Existing scoped context and restart cache pass real HTTP continuation/permission tests; no demonstrated missing state justifies a second owner. |
| Intermediate SQL restoration during command admission | Remove | Failed isolation/write-count checks; the accepted command already owns persistence. New path cuts a write and binding bytes with message/Worker parity. |
| Replace reducer semantics at the same time | Reject for this slice | Would enlarge the correctness surface without being necessary to eliminate the measured write. Revisit for a measured remaining aggregate cost. |
| Additional retry coordinator | Reject | Real lost-response/restart/changed-state trial succeeds with existing operation IDs and receipts. |
| Full archive reversal | Retain | Different recovery purpose, with existing reverse-migration tests; deleting it would remove a demonstrated capability. |
| Broad automatic cache purging or new memory feature | No change | Cache retention is explicitly documented and no new requirement establishes a need here; don't disguise adjacent feature work as continuity repair. |
| Claim a world-best speedup | Reject | Local binding-byte improvement is demonstrated; end-to-end productivity and production latency are unmeasured. |

Lint completed with zero errors (290 repository warnings); design-token,
reachability, i18n and generated UI-string checks passed. Documentation links: 564
passed. These checks do not replace full release qualification.

## Integration closure and faster development loop

The branch-wide affected run selected 375 files and ran 2,428 tests in about 150s:
2,426 passed, two failed. Both failures were integration evidence drift: the
candidate manifest still pinned an earlier schema, and an integrity test expected
partial replay in the serving cursor. Regenerated the manifest to schema 41.
Changed the interruption assertion to require durable staging progress AND no
partial serving head/rows, preserving the actual safety invariant. Both affected
files reran: 20 tests passed. The full 375-file run was not repeated after these
test/manifest-only repairs; this is not a claimed single all-green full-suite run.

For subsequent slices, use the existing selector with an exact checkpoint base:
`node scripts/verify-affected.mjs --base=f1948f32 --budget=30 --list` selected 116
files instead of 375. It explicitly omitted 709 related files for time; this is a
fast iteration loop, not release qualification. Keep deliberate message, privacy,
recovery and Worker owners where the time selector cannot guarantee their inclusion.
Run broader integration once at a checkpoint, not on every small edit. Reuse
working contracts and tests; add regression coverage only for a new failure or
unproved critical interaction. No new runner or orchestration framework is needed.

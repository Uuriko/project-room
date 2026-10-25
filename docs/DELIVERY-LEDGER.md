# Project Room delivery ledger

Execution order and complete scope mapping: [build-to-completion plan](BUILD-TO-COMPLETION-PLAN.md).

Updated 2026-10-18. Owner role for these local items: Codex implementation.
This ledger preserves the seven stages in the [execution plan](ARCHITECTURE-EXECUTION-PLAN.md),
plus the [infra research](FRONTIER-INFRA-RESEARCH-2026-10-18.md) and
[startup/product strategy](STARTUP-RESEARCH-AND-PRODUCTIVITY-STRATEGY.md).
Detailed requirements in those documents remain binding; these rows do not replace them.

Statuses: qualified checkpoint = local evidence recorded, not production release;
in progress = partial implementation; planned = accepted work outstanding;
experiment = hypothesis awaiting validation. Do not delete unresolved rows. A
superseded row requires a reason and replacement ID. Completion requires linked
evidence and a source revision, not just a checkbox.

| ID | Scope / status | Dependencies | Acceptance evidence required |
|---|---|---|---|
| A1 | Reader/query cutover — in progress | None | Remaining consumers use explicit bounded contracts; privacy, ordering, export and recovery parity |
| A2 | Canonical message entity writes — in progress | A1 contracts | Transaction-scoped contexts, touched outputs, no unrelated serialization, differential command tests and reversal |
| A2.1 | Schema 41 replay isolation — qualified checkpoint | Schema 40 | [Recorded tests and measurements](MESSAGE-REPLAY-ISOLATION-PLAN.md); final broad release qualification remains A7 |
| A3 | Independent work/attempt/artifact aggregates — planned | A2 boundary pattern | Independent revisions/storage; cross-domain transactions, resumable migration, semantic parity and reverse migration |
| A4 | Durable scheduling — planned | A3 | Due records committed with originating writes; no read-triggered flush; leases, fencing, retry, cancellation and restart drills |
| A5 | Room authority and placement — planned | A3, A4 | One accepting authority, epoch migration, rollback and global identity/inbox continuity |
| A6 | Human/agent contracts — in progress | A1, A3 | Consistent bounded packets, offline drafts, resumable attempts, provenance and executable journeys |
| A7 | Qualification, cleanup and release — planned | A1–A6 | Main reconciliation, full supported-platform suites, Workers/browser/failure/migration evidence; compatibility removal; release authorization and rollback |
| R1 | Incremental dependency views — experiment | A3 | Compare incremental against full recompute; bounded invalidation; CPU/bytes under realistic deltas |
| R2 | Bounded replay generations — experiment | A2.1 | Chunked builder, constant-size publication, crash/privacy/concurrent-write parity and total rebuild cost |
| R3 | Durable operation identity — planned | A3, A4 | Retry/effect ledger; idempotent sink and non-idempotent negative-control cases; no unsupported exactly-once claim |
| R4 | Versioned execution context — planned | A3, A6 | Resource/tool/prompt revisions, revocation handling and explicit incompatibility on resume |
| R5 | Open-loop/fault performance qualification — planned | A2, A4 | Tail latency under load, coordinated-omission-aware measurement, overload/retry recovery and reproducible environments |
| P1 | Executable capability contracts — planned | A1, A6 | Extend existing catalog/discovery/MCP/CLI; parity and permission tests; three fresh-session journeys |
| P2 | Work-centered activity and review experience — planned | A3, A6 | Intent → attempt → artifact → evidence → acceptance → continuation, tested by humans and agents |
| P3 | Failure-to-evaluation loop — planned | P1, P2 | Reviewed sanitized traces become versioned independent regression cases; owner and fix linkage |
| P4 | Inspectable project memory — planned | A3, A6 | Source/revision/scope/correction/deletion; bounded retrieval and contradiction tests |
| P5 | Environment and connector adapters — experiment | R3, R4 | Select only adapters needed by journeys; warm/cold reconstruction, authority and cost evidence |
| M1 | Comparative productivity study — planned | P1, P2 | Pilot, predeclared task cohorts, counterbalanced baselines, human time, quality/cost guardrails and uncertainty |
| M2 | Multidimensional quality qualification — planned | A1–A6 as relevant | [Scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md), actual baselines and reproducible tests; no target labeled achieved without data |
| G1 | Historical commitment reconciliation — planned | None | Audit earlier strategy documents, chat decisions and active branches; map commitments here with source and disposition |

## Next implementation sequence

1. Finish A2 explicit contexts and command parity, preserving A1 unfinished consumers.
2. Split A3 aggregates and establish R3/R4 contracts. Start P1 journey instrumentation
   against existing interfaces so improvements have a baseline.
3. Implement A4; evaluate R1/R2 with recorded stop rules. Connect P2/P4 through A6.
4. Complete A5, all remaining A6 requirements, then A7. Run P3, M1 and M2 against
   actual delivered behavior. G1 may add obligations; it never silently removes one.

New research is not a reason to abandon this sequence. Independent measurement and
source reconciliation can proceed without waiting for every architectural stage.

## Automation research additions (2026-10-18)

See [automation design](AUTOMATION-RESEARCH-AND-EXECUTION-DESIGN.md). These extend
existing work; no automation has been activated by writing this plan.

| ID | Scope / status | Dependencies | Acceptance evidence required |
|---|---|---|---|
| AU1 | Existing automation inventory and baseline — planned | G1, M2 | Caller/test inventory, task episode denominators, current manual effort and exceptions |
| AU2 | Readiness, evidence freshness and review packets — planned | A3, A4, A6, AU1 | Revision-aware due work, stale-check invalidation, independently verified packets and reduced human effort |
| AU3 | Commitment reconciliation — planned | G1, P2 | Source-linked commitments, explicit disposition, false-positive/omission evaluation; no automatic abandonment |
| AU4 | Recovery and contract checks — planned | R3, R4, P1, AU1 | Crash/effect reconciliation and executable discovery journey qualification |
| AU5 | Regression and research experiment pipelines — experiment | P3, M1, AU1 | Reviewed oracles, source provenance, bounded budgets and useful finding yield |
| AU6 | Resource/knowledge maintenance and quiet briefs — experiment | R1, P4, AU1 | Scoped invalidation, deletion/revocation parity, quality-adjusted cost and notification usefulness |

## Adaptive system additions (2026-10-18)

The [master plan](ADAPTIVE-PROJECT-ROOM-MASTER-PLAN.md) sequences all work above
into six integration packages without replacing the original seven stages.

| ID | Scope / status | Dependencies | Acceptance evidence required |
|---|---|---|---|
| AD1 | Versioned observations and experiment registry — planned | A3, M2, AU1 | Task/cohort/policy provenance, denominators, retention and immutable candidates |
| AD2 | Offline and shadow adaptation harness — planned | AD1, P1, P3 | Baseline/held-out comparisons, budget stops, false-improvement rejection, independent verifier and reproducibility |
| AD3 | Bounded adaptive execution policies — experiment | AD2, A4, R3, R4 | Quality-matched improvement, drift detection, stability under load, scoped authorization and rollback |
| AD4 | Adaptive memory and context — experiment | AD2, P4, R1 | Relevance/freshness improvements at fixed budget, contradiction correction and source deletion/revocation propagation |

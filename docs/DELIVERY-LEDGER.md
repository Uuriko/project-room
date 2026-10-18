# Project Room delivery ledger

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

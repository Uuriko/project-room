# Testable quality beyond speed

2026-10-18. Decision: strengthen existing components and their connections.
These are proposed measurements and provisional gates, not established product
results. Owner: Codex implementation for harnesses; product owner for acceptance
rubrics and eventual participant studies. Review by implementation slice and before
release. Link evidence to M2 in the [delivery ledger](DELIVERY-LEDGER.md).

## Outcome measures

Keep two primary product outcomes: accepted outcomes per active human hour and
time to verified acceptance. Definitions and comparative study controls live in the
[startup strategy](STARTUP-RESEARCH-AND-PRODUCTIVITY-STRATEGY.md). The factors below
explain why those outcomes improve or degrade; they are not sixteen competing
north-star metrics or a weighted score that allows privacy failures to disappear.

## Qualification matrix

| Factor | What to measure / unit | Test and evidence | Initial decision rule |
|---|---|---|---|
| Correctness | Independently accepted tasks / assigned tasks; escaped defects per accepted task | Fixed rubric and hidden fixtures; rejected commands; independent artifact review; seven-day rework | No critical semantic regression; improve acceptance without hiding failed episodes |
| Reliability | Lost acknowledged operations; duplicate effects; recovery success / injected failures | Kill at transaction/effect boundaries, duplicate deliveries, reopen and compare semantic records | Zero lost acknowledged operations in supported fault model; explicit reconciliation for uncertain external effects |
| Human effort | Active minutes per assigned task, including review/correction; avoidable questions | Instrument episodes and validate with observed sessions; distinguish user decisions from redundant prompts | First target 50% less context reconstruction, no reduction in perceived control |
| Context quality | Relevant evidence recalled; unsupported claims; stale or unauthorized references | Expert-labeled evidence sets, fresh/stale/conflicting documents, private distractors, changed permissions | No unauthorized disclosure; retrieval/grounding improves versus current baseline at a fixed byte budget |
| Continuity | Handoff success; repeated instructions; minutes to resume | New agent/user with no prior chat; interrupted run; changed resource version | At least 95% success in declared supported handoff suite before broad claims; report uncertainty |
| Discoverability | Fresh-session completion; wrong URLs/tools; time to first valid action | Extend existing onboarding probes; docs-only, CLI and MCP entry points | At least 90% completion initially on fixed suite, zero undocumented privileged setup |
| Interface consistency | Contract discrepancies across UI/API/CLI/MCP; error-recovery success | Run equivalent actions against the same state and principal; compare results and authority | Zero semantic/permission drift on supported capabilities; presentation may differ |
| Cost efficiency | Model + compute + storage + network cost per accepted outcome | Include unsuccessful attempts, retries, idle runners and amortized environment startup | No cost regression accepted without an explicit measured quality/effort benefit |
| Resource efficiency | CPU-ms, peak RSS, serialized/query/WAL bytes per operation; idle work | Fixed-size touched sets with 1k/10k/100k and later 1m histories; real adapter runs | Under 10% growth from unrelated history as a hypothesis; report physical writes separately from WAL bytes |
| Maintainability | Files/domains touched for a standard change; time to implement and review; central-module growth | Repeat representative change exercises, dependency checks and review evidence | New domain behavior should not require editing unrelated reducers/services; investigate boundary violations |
| Change safety | Failed changes / releases; rollback time; migration reversal parity | Historical release records when available; crash during migration; rollback rehearsal | Reversible local migration and old-writer fencing before cutover; set production rates only after collecting baselines |
| Test effectiveness | Seeded realistic faults detected / inserted faults; flakes / runs; time to diagnose | Mutation/fault cases around permissions, ordering and retry; repeated unchanged runs | Every critical invariant has a failing negative control; no unexplained flake promoted to release evidence |
| Accessibility | Critical journeys completed with keyboard and screen reader; severe automated findings | Real assistive-technology walkthroughs plus automated checks, zoom and reduced motion | All three core journeys usable without pointer; zero critical accessibility blockers |
| Comprehension and control | Correct next-action identification; unwanted actions; ability to cancel/undo within documented scope | Task-based usability sessions; inspect current status, recover and correct a result | Zero misleading completed states; cancellation prevents future uncommitted effects within stated semantics |
| Portability | Semantic export/import parity; time and manual steps to change runner/provider | Round-trip rooms, identities, attachments, evidence and cursor state; adapter swap | No silent data loss; document genuinely nonportable external state and credential requirements |
| Operational simplicity | Manual recovery steps, alert precision, operator minutes per incident | Controlled incident drills with new operator and written runbook | Common supported failures recover automatically or yield one actionable diagnosis; measure alert false positives |

Thresholds without measured baselines are hypotheses. A zero-failure result in a
finite suite is not proof of zero production failure probability. Report sample
size and fault coverage. For stochastic success rates use confidence intervals;
95 successes in 100 trials does not establish a true 95% lower bound. Human studies
need participant/project-level uncertainty and accessible recruiting.

## Test the connections, not just components

The integration unit is a complete journey with a stable task ID:

1. **Discover → act:** a fresh agent uses existing discovery to find an allowed
   command, executes it and interprets its typed result. Measure unnecessary
   requests, hidden prerequisites and authority consistency.
2. **Intent → execution:** a person creates work; the attempt inherits the right
   constraints and source revisions without copying a conversation. Measure
   lost constraints, redundant questions and time spent reconstructing context.
3. **Execution → evidence:** a result links to the exact artifact revision and
   independent checks. Change the artifact after verification and ensure evidence
   is marked stale instead of continuing to imply correctness.
4. **Interruption → continuation:** terminate an attempt, switch runner and resume.
   Include changed permissions and unavailable resources. Measure duplicated
   effects, repeated work and quality of the next actionable state.
5. **Feedback → improvement:** correct a failure, preserve a sanitized case, rerun
   the old and new implementation. Verify that the new case catches the old bug
   and does not merely assert the new implementation's shape.
6. **Privacy change → every representation:** revoke access or delete data while
   snapshots, caches, indexes and exports exist. Verify all relevant surfaces,
   including delayed jobs and resumed attempts, respect the new authority.

These journeys connect the existing capability/discovery code, work board,
attempt services, artifacts, signed evidence and onboarding probes. Inventory
what each already guarantees before changing schemas or adding services.

## Small first benchmark corpus

Create twelve fixed scenarios: simple message correction, old-message correction,
private-context lookup, fresh-agent onboarding, research with conflicting sources,
work assignment, artifact review, interrupted attempt, duplicate external request,
permission revocation, migration recovery and export/import. Add realistic scale
variants only where scale changes the claim. Keep task inputs, expected evidence,
authority, environment and versioned fixture IDs alongside every result.

Each run records: scenario and task IDs, source revision, runtime/adapter/model
versions, configuration, cold/warm condition, assigned/accepted/failed status,
active human time, elapsed time, rework, cost, bytes/CPU/memory where applicable,
and evidence references. Redact private content; metadata can also disclose
sensitive activity and needs an explicit retention/access policy.

Start by measuring existing behavior. For each architectural change, rerun affected
invariants and scenarios; broaden testing when the boundary or evidence warrants
it. Publish a vector of outcomes and failures rather than one flattering aggregate.
Do not let a microbenchmark substitute for task acceptance, or an agent's own
confidence substitute for independent verification.

## Prioritization

Use the largest observed source of wasted effort or failed outcomes to choose the
next optimization. If review takes twenty minutes and execution takes two seconds,
another tenfold command speedup contributes little to the workflow. If a room
rebuild blocks every operation for minutes, recovery architecture is material even
when normal edits are sub-millisecond. Reliability, maintainability and context
quality make future speed gains cheaper and more useful.

Current next step remains canonical entity contexts and independent aggregates.
Add baseline instrumentation to existing journey probes while doing that work.
The scorecard changes acceptance criteria; it does not create a competing rewrite.

## Automation-specific outcomes

The [automation research](AUTOMATION-RESEARCH-AND-EXECUTION-DESIGN.md) adds operational
definitions for commitment retention, blocked time, evidence freshness, first-pass
acceptance, decision burden, coverage, unattended success, exception burden,
notification usefulness, knowledge reuse, recurrence, predictability and improvement
yield. Use the relevant subset per workflow and include supervision/repair costs.

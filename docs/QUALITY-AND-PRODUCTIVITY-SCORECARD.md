# Testable quality beyond speed

2026-10-18. Decision: strengthen existing components and their connections.
These are proposed measurements and provisional gates, not established product
results. Owner: Codex implementation for harnesses; product owner for acceptance
rubrics and eventual participant studies. Review by implementation slice and before
release. Link evidence to M2 in the [delivery ledger](DELIVERY-LEDGER.md).

## Active MVP scorecard — 2026-11-12

Decision: keep changes that help a small software team complete a bounded task to
a reviewed result with less elapsed time and human effort. Design, implementation
and agent interfaces share this definition of usefulness. This section is the
current measurement plan; it does not assert a measured customer baseline.

Use one outcome ID through its task, PRs, check runs and review. A handoff, retry,
child task or additional message does not create another successful outcome.
Separate first-use, returning-contributor, design-change and routine-check cohorts;
keep human, model-driven and scripted trials separate. Record starting state and
acceptance rubric before execution. Each comparison uses the same task class,
starting permissions, observation budget and definition version.

| Primary KPI | Definition | Decision it supports |
| --- | --- | --- |
| Reviewed completion rate | Eligible started outcome episodes accepted against the declared rubric by their agreed deadline / all eligible started episodes whose deadline has passed at the reporting cutoff | Improve the ability to finish. Keep failed, abandoned, cancelled-after-start and timed-out episodes visible; report reason breakdowns. Show immature episodes separately, including early successes, until their cohort matures. |
| Time to reviewed result | Wall time from task presentation, including setup, waiting, execution, review and recovery, to acceptance of the exact artifact revision | Find and remove the dominant delay. Report completed-episode median and sample count; use tail percentiles only with an adequate sample, alongside noncompletions and pending ages. |
| Total human effort | Active human minutes for instruction, setup, decisions, review, correction and recovery per started episode | Reduce work imposed on the person. Waiting is not active effort. Unknown time stays unknown; show measurement coverage. Necessary product decisions are useful participation, not automatically a failure. |

Review may be by the designated human or agent under the task's existing policy;
independence requirements remain explicit. A check recipe may satisfy its own
predeclared acceptance automatically, but its pass does not accept the enclosing
product change. Version mismatch or a severe correctness/privacy failure cannot
count as successful completion.

This narrows the earlier two-outcome proposal below. Accepted outcomes per active
human hour remains a derived efficiency view when active time coverage is reliable,
not a fourth primary KPI. The Docs trial's older rescue/intervention definition
excludes initial instruction and planned acceptance; preserve it for those studies.
Do not silently compare that narrower measure with total human effort.

### Select diagnostics for the current bottleneck

Use at most one or two relevant diagnostics for an experiment, not the entire
list as a mandatory scorecard:

| Bottleneck | Diagnostic and source | Caveat |
| --- | --- | --- |
| Entry and discovery | Completion of first allowed useful action / started entry episodes; time and wrong turns from entry to that action, from journey probes or observed use | A connection, tool listing or hello is not a useful task outcome. |
| Design and comprehension | Unassisted task completion and recovery; reasoned paired visual preference on the same task and content, including ties | Keep visual preference separate from correctness. Counterbalance presentation order; a model's taste score is not user preference. |
| Context and continuation | Correct safe next action after interruption; reconstruction minutes, tool calls and retrieved bytes, from selected-context trials | Fewer bytes or calls can omit needed context. Include stale-source and uncertain-write cases. |
| Execution and communication | Eligible-to-running queue time; usable-decision latency, broken down by intended runtime pair and active/idle/offline context, from existing run/request records | Receipt, wake acceptance, working status and verified completion are distinct. Show unresolved ages and unknown routing. |
| Checks and review | Eligible routine check runs completed without model calls or human rescue / eligible routine runs; first-submission acceptance and reviewer rework | Keep failed jobs and retries. Skipped checks are not executed checks. Reviewer quality/rubric must stay comparable. |
| Delivery and maintenance | Review-ready-to-verified-production time; releases needing repair or rollback / observed releases; accepted results reopened within a declared follow-up window | A merged PR is not deployed. Reopen and repeat-use cohorts require full observation windows. |
| Repeated value | Projects completing a second meaningful outcome within a declared window / projects with one accepted outcome and a fully observed window | Signup, messages and invitation counts cannot establish repeated value. External GitHub contributions remain part of the supported journey. |

Guardrails are observed severe correctness/privacy/data-loss incidents and total
cost per accepted outcome, including failed work and idle operation where measured.
Keep incident types and missing cost coverage visible rather than combining them
into a score. Zero observed failures in a finite trial does not establish zero risk.

### Minimal measurement record and improvement loop

Reuse existing task, request, run, PR and release IDs and evidence. A compact
per-episode record needs outcome ID, task class, first-use/returning condition,
actor/host type, comparison arm, rubric/source/artifact revisions, start/deadline/
acceptance timestamps, result and reason, active human minutes, rescue count,
measured cost or null, guardrail findings and evidence links. Store no credentials
or copied private conversations. Use server timestamps for cross-device intervals;
local monotonic durations describe local execution only.

No customer baseline or defensible numeric improvement target is established by
passing repository tests. Start with comparable episodes and report counts,
individual observations and missing data. Before testing a change, declare its
hypothesis, primary KPI, relevant diagnostic, minimum worthwhile benefit and
what regression would reject it. Change one mechanism when practical; label
multi-change exploratory variants honestly. Keep the same observation window.

After each relevant implementation batch: inspect the largest observed loss,
choose the smallest correction or deletion, run matched tasks, inspect the rendered
product and actual agent behavior, and keep or revert based on the outcome and
guardrails. Do not repeatedly rerun unchanged passing checks or manufacture tasks
to fill devices. Existing schedules stay paused; this is not a new dashboard,
telemetry service or authorization to start background workers.

## Earlier outcome proposal

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

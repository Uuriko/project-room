# An adaptive Project Room: cohesive vision and completion plan

2026-10-18. This is the navigation and sequencing layer for the existing overhaul,
not a replacement scope. Track status in the [delivery ledger](DELIVERY-LEDGER.md).
Architecture requirements remain in the [execution plan](ARCHITECTURE-EXECUTION-PLAN.md).
Supporting evidence: [infrastructure research](../archive/docs/plans/FRONTIER-INFRA-RESEARCH-2026-10-18.md),
[startup research](STARTUP-RESEARCH-AND-PRODUCTIVITY-STRATEGY.md),
[automation design](AUTOMATION-RESEARCH-AND-EXECUTION-DESIGN.md), and
[quality scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md).

Implementation packages, dependencies and exit gates are specified in the
[build-to-completion plan](BUILD-TO-COMPLETION-PLAN.md).

## Vision

Project Room holds the intent, knowledge, execution and evidence of a project.
People and agents share durable work objects; each successful result becomes
reusable knowledge, and each verified failure becomes an opportunity to improve.
The product adapts its execution and presentation to context without making its
meaning, permissions or controls unpredictable.

The measurable objective is more accepted work per human hour, with less elapsed
waiting, rework, cost and coordination. Improvement is multidimensional: faster
execution that creates more review work may lose; a slightly slower operation
that removes an entire handoff may win. No single score can excuse loss of data,
unauthorized actions or false completion claims.

A living system needs both plasticity and stable identity. Goals, authority,
transactional invariants, evidence identity and user control form the stable core.
Versioned policies, retrieval strategies, prompts, presentation preferences and
execution settings are the parts we can experiment with. An optimizer cannot
silently rewrite its objective or its evaluator to declare itself successful.

## The improvement loop

**Observe → diagnose → propose → test → adopt within policy → monitor → revert or retain.**

Observe complete task episodes and attributable resource costs. Diagnose which
part of the journey caused lost effort. Propose a small versioned candidate with
a hypothesis. Test offline and in shadow mode before influencing real outcomes.
Adopt only within an existing authorization and rollout policy. Monitor both
benefits and regressions, retain the prior policy for reversal, and preserve the
result as evidence even when the experiment fails.

Research supports parts of this design:

- [DSPy](https://arxiv.org/abs/2310.03714) separates declarative language-model
  modules from optimization. This suggests explicit typed task boundaries and
  evaluation-driven prompt changes instead of ad hoc prompt edits.
- [GEPA, revised February 2026](https://arxiv.org/abs/2507.19457) uses execution
  feedback to propose and compare prompt candidates. Its reported task results
  motivate an experiment here; they do not establish our expected gain.
- An [October 8, 2026 preprint](https://arxiv.org/abs/2610.12601) examines reflective
  optimization using topic-disjoint evaluation, multiple seeds and verifier
  ablations. Its authors report selection and judge effects that complicate
  apparent gains. We should isolate held-out projects/topics and test transfer,
  rather than repeatedly optimize against the same acceptance examples.
- [Microsoft's experimentation guidance](https://www.microsoft.com/en-us/research/articles/patterns-of-trustworthy-experimentation-during-experiment-stage/)
  emphasizes guardrails and data quality during experiments. Our control loop
  must verify measurement integrity before reacting to an apparent improvement.

These mechanisms can be implemented incrementally; a new framework dependency
is an option to evaluate, not an architectural requirement.

## What adapts, and how

| Area | Context and proposed adaptation | Evidence required | Boundary |
|---|---|---|---|
| Execution speed | Queue load, touched-set size and latency → bounded batching, concurrency and cache policy | Open-loop tails, CPU, queue age, fairness and overload recovery | Fixed hard resource bounds; hysteresis/cooldown prevent oscillation |
| Runtime memory | Working-set pressure → cache eviction, chunk sizes and selective hydration | Peak memory, hit rate, latency and correctness under pressure | Never evict authoritative data or omit required command references |
| Project memory | Relevance, source age and corrections → retrieve, consolidate or flag stale knowledge | Grounded retrieval, contradiction/deletion tests and human correction rate | Provenance and access scopes persist; summaries do not replace authoritative evidence |
| Data management | Dependency changes → incremental projections, invalidation and generation rebuilds | Full-recompute parity, recovery time, write amplification and publication bounds | Versioned schemas, explicit migrations, rollback evidence |
| Agent behavior | Task class and observed failures → prompt/tool sequencing candidates | Hidden task suites, independent graders, repeated runs and cost comparison | Optimizer cannot access held-out answers or change acceptance criteria |
| Model/runner selection | Task requirements, empirical quality and cost → routing candidate | Quality-matched outcomes, cohort effects and failure rates | Capability/permission constraints first; no paid exploration without configured budget |
| Human experience | Role, task phase and explicit preferences → relevant views and decision packets | Task completion, comprehension, interruption burden and accessibility | Stable navigation, visible adaptation and reversible user preferences |
| Workflow automation | Proven repeated sequence → reusable template and bounded automation | Net human time saved, exceptions, coverage and effect integrity | Automation cannot grant itself new authority |
| Codebase improvement | Repeated bottleneck/failure → candidate patch and reproducible benchmark | Independent tests, migrations, reviewable diff and measured improvement | Isolated branch; production release follows authorized lane |

Separate machine memory efficiency from project knowledge quality. Increasing
stored text can worsen both retrieval and cost. Treat forgetting as a governed
operation: expiry for caches, explicit retention for traces, and deletion propagation
for knowledge. A source deletion or revoked permission invalidates dependent
summaries and cached packets; it must not remain available through learned memory.

## Reuse and connect the existing system

The domain kernel remains authoritative. Work items refer to attempts, artifacts,
checks and decisions. Domain events feed a bounded durable queue. Workers call
existing capability contracts and produce receipts. Context services assemble
consistent authorized packets. Observation records connect task outcomes to the
version of the policy, context and runtime that produced them.

The adaptive layer consumes those observations and proposes policy versions; it
must not become another room database, another message bus or a second general
agent orchestration engine. Existing work wakes, budgets, handoff envelopes,
discovery, capabilities, verification and metrics are integration points. A code
inventory is required before creating a new equivalent service.

An experiment record needs a stable ID, parent policy version, hypothesis,
workflow/cohort, dataset versions, objective and guardrails, resource budget,
allowed changes, comparison method, evidence references, result and rollback
policy. The production executor reads an approved policy version; the optimizer
writes candidates. Keep these roles separate even if both initially run inside
one process.

Use immutable policy versions and cohort assignment. In a collaborative room,
randomize at room/project level when user-level assignment would contaminate
results through shared state. Record assignment and treatment exposure. Do not
repeatedly peek at ordinary significance tests; use fixed horizons or a valid
sequential design. Small samples call for offline trials and cautious judgment,
not invented certainty. Drift triggers reevaluation, not automatic retraining
on unverified feedback.

## Concrete completion sequence

Each package ends in a reviewable code checkpoint and evidence. Local qualification,
release qualification and deployed status remain distinct. No dates are invented
before the remaining implementation inventory is complete.

### Package 1 — Finish the domain boundary

Ledger: A1, A2, A2.1; reconcile G1 alongside implementation.

Implement transaction-scoped message contexts with referenced entities and ancestry,
explicit touched outputs and shared metadata changes. Preserve authority and
idempotency ordering. Cover posts, edits, replies, polls, pins, deletion, receipt
withdrawal, rejected commands and cross-domain references. Complete remaining
reader contracts. Compare against existing reducer behavior and test reversal.

Exit: supported entity operations do not serialize unrelated history; current
readers and recovery preserve semantics. Retire superseded restoration/dual-write
paths only after consumers are proven migrated. Schema 41 replay isolation is
already a qualified checkpoint, not completion of this package.

### Package 2 — Independent durable work

Ledger: A3, R3, R4, A6 foundations.

Give work, attempts and artifacts independent repositories and revisions. Add
versioned context manifests and stable logical operation identities. Preserve
cross-domain atomicity, source lineage, cancellations and receipts. Migrate with
semantic comparisons and reversible checkpoints.

Exit: one work change leaves unrelated aggregates untouched; a new runner can
resume an attempt and resolve an uncertain effect without blind duplication.

### Package 3 — One useful automated vertical slice

Ledger: A4, AU1, AU2, P1, P2.

Connect existing dependency state, wakes and verification to the durable due queue.
Deliver the complete journey: dependency resolves → readiness reevaluated → allowed
attempt proceeds → artifact produced → independent checks run → review packet
appears. Artifact changes invalidate affected evidence. Preserve quiet notification
policies and useful terminal states.

Exit: duplicate/reordered events, crashes, revocation and cancellation are tested;
manual effort and exception costs are measured against the existing workflow.
This slice is the first product proof of the rebuilt architecture.

### Package 4 — Measurable, bounded adaptation

Ledger: AD1–AD3, M1, M2, P3, P4, AU3–AU6 as applicable.

Add episode telemetry and an experiment registry over the existing work records.
First compare deterministic cache/retrieval policies; then evaluate a bounded
prompt or tool-order optimization for one journey. Keep a fixed baseline and
hidden transfer cases. Automate regression checks and candidate generation before
considering autonomous promotion. Integrate commitment reconciliation and failure
fixtures, so learning also prevents previously identified work from disappearing.

Exit: a complete candidate lifecycle can show improvement, reject a deceptive
improvement, stop at budget, and revert a simulated regression. Automatic adoption
is initially restricted to reversible configuration within an approved policy.
Code/schema changes remain reviewable changes through the release process.

### Package 5 — Recovery, scale and complete experience

Ledger: R1, R2, R5, A5, remaining A6.

Prototype incremental views and bounded replay generations against observed costs;
select using parity and workload evidence. Complete room authority/placement and
migration rollback. Finish offline draft/conflict behavior, consistent context
packets, keyboard/screen-reader journeys and export/import qualification.

Exit: bounded publication and hot-room isolation have measured evidence; migrations
preserve identities, cursors, attachments and visibility; all promised human/agent
journeys work across supported failures and environments.

### Package 6 — Reconcile, remove and qualify

Ledger: A7, G1, all remaining accepted items.

Reconcile current main and other active branches. Resolve every historical
commitment to an implemented item, explicit remaining requirement or a documented
supersession; an unreviewed absence is not completion. Run supported-platform unit,
Workers, browser, privacy, migration/reversal and failure qualification. Remove
retired compatibility paths with evidence. Record comparative product outcomes,
known limits, rollout and rollback procedures. Production release requires the
current session's authorization and the serialized deployment lane.

Exit: all seven original architecture exit criteria and accepted added scope have
evidence. Experiments have explicit results and adoption/rejection decisions;
rejected hypotheses are not silently treated as unfinished features. Any retained
unimplemented commitment keeps the overall effort open.

## What we build first inside the adaptive layer

1. A versioned experiment record and machine-readable episode format.
2. A deterministic baseline runner using existing onboarding/work tests.
3. An evidence comparison that separates quality, human effort, latency and cost.
4. A shadow candidate policy; no live side effects during comparison.
5. Budget, provenance and rollback tests, including an apparently faster candidate
   that fails quality or permission checks and must be rejected.

These are concrete AD1/AD2 deliverables after domain and telemetry foundations.
Do not begin with an unrestricted self-editing production agent. The route to
more capable autonomy is a system that can reliably tell when a change helped.

# Automation that produces accepted outcomes

Research date: 2026-10-18. Extends the [quality scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md)
and [delivery ledger](DELIVERY-LEDGER.md). This is a product architecture and research
checkpoint; no recurring jobs, external messages, deployments or purchases were activated.

## Decision

Automate repeated coordination, verification, maintenance and context preparation.
Use deterministic code for known rules, bounded agent runs for ambiguous work,
and human judgment where goals, consequences or acceptance remain unclear.
The product should keep work moving and evidence current while asking for fewer,
better decisions. Automation volume is not the outcome.

The initial priority is a connected readiness and evidence workflow: when a work
item or dependency changes, determine what is ready, what is stale, and who can
perform the next authorized step. Reuse existing work state, wakes and receipts.
This is a product slice of the planned durable scheduler, not a second scheduler.

## Research findings

- **Google SRE:** toil includes repetitive operational effort that scales with
  service growth. Running a script manually still consumes operator time. Its
  workbook recommends identifying and prioritizing toil using effort saved and
  implementation cost. Our application: measure supervision and cleanup, not
  just execution time. [Toil workbook](https://sre.google/workbook/eliminating-toil/).
- **Cursor:** automations combine triggers, instructions and selected tools;
  source-control, scheduled and webhook triggers cover different workflows.
  Runs consume cloud-agent resources. Our application: event triggers plus
  bounded budgets, with schedules mainly for reconciliation or explicitly timed
  tasks. [Current documentation](https://cursor.com/docs/cloud-agent/automations).
- **Linear:** its recommended progression is to solve a real task, preserve a
  useful skill, share it when stable, then automate recurring work with Loops.
  September's product-management examples address keeping plans synchronized
  after scope changes. Our application: promote proven workflows, rather than
  launching speculative recurring agents everywhere.
  [Agent documentation](https://linear.app/docs/linear-agent),
  [September 14 update](https://linear.app/changelog/2026-09-14-loops-for-product-management).
- **Anthropic:** evaluation should inspect actual outcomes as well as execution
  traces; layered graders catch different failures. Its long-running harness
  discussion explicitly acknowledges orchestration complexity and overhead.
  Our application: independent checks, bounded repair and evidence of net benefit.
  [Agent evaluations](https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents),
  [Harness design](https://www.anthropic.com/engineering/harness-design-long-running-apps).
- **Temporal:** Nexus handlers have at-least-once execution semantics; retries can
  invoke handlers again. Our application: stable logical operation identity and
  receiver-side deduplication or explicit uncertain-outcome reconciliation. Durable
  orchestration alone does not make external effects exactly once.
  [Nexus operations](https://docs.temporal.io/nexus/operations).
- **Academic reliability research:** tau-bench evaluates tool interaction and
  repeated-run reliability; ReliabilityBench proposes testing repetition,
  equivalent task perturbations and controlled tool faults. Their workloads do
  not establish Project Room performance. Adapt the experimental dimensions:
  repeated trials, paraphrases, timeouts, duplicates and permission changes.
  Distinguish pass^k (consistent success across repetitions) from pass@k (at least
  one success among attempts); a lucky retry is not dependable automation.
  [tau-bench](https://arxiv.org/abs/2406.12045),
  [ReliabilityBench preprint](https://arxiv.org/abs/2601.06112).

These are primary documentation, practitioner accounts and research proposals.
They support mechanisms and experiment design, not a claim that any vendor's
automation will improve our productivity by a known percentage.

## When automation makes economic and product sense

For a fixed observation period, estimate net human minutes saved as:

`eligible episodes × baseline active minutes − actual automation-related human minutes − amortized maintenance minutes`.

Actual minutes include setup, review, exceptions, correction and recovery across
successful AND failed episodes. Keep compute/model cost and consequential errors
as separate dimensions; do not conceal a damaging error inside average minutes.
Counterfactual baseline effort needs matched tasks or randomized/stepped rollout,
not an agent's estimate of how long a human would have taken.

Automate when the event is detectable, required context is accessible, authority
is explicit, success is checkable, failures are recoverable and the workload
recurs enough to repay implementation and maintenance. First remove redundant
steps; then simplify; then automate the remaining work. Automation that preserves
an unnecessary workflow is an expensive way to retain the problem.

A practical ladder is observe-only, propose, execute reversible internal changes,
and execute a narrowly authorized external workflow. Promotion requires evidence
for that workflow class. Model-reported confidence is not sufficient. Regressions,
permission changes or verifier drift can demote an automation. Budget exhaustion
must produce a useful handoff, not an infinite retry loop.

## Additional measurable outcomes

| Outcome | Operational definition | Automation opportunity / gaming risk |
|---|---|---|
| Commitment retention | Accepted commitments with a current owner or explicit disposition / all accepted commitments | Reconcile plans and work items; do not manufacture closure by expiring wanted work |
| Blocked-work burden | Blocked duration per task, with current blocker and dependency provenance | Detect resolved prerequisites and wake ready work; premature unblocking is a failure |
| Evidence freshness | Share of required checks valid for current artifact AND relevant dependency revisions | Invalidate and selectively reverify; passing an old check does not count |
| First-pass acceptance | Results accepted without substantive correction / submitted results | Preflight and independent checks; retain rejection and withdrawal denominators |
| Decision burden | Necessary human decisions and avoidable interruptions per accepted outcome | Batch context and provide complete decision packets; fewer questions must not hide unauthorized actions |
| Coordination completeness | Handoffs with outcome, next step, source revision and owner / handoffs requiring them | Generate bounded handoffs and flag missing inputs; field presence is not semantic correctness |
| Automation coverage | Eligible episodes handled / all eligible episodes under a predeclared policy | Track unsupported and declined cases so scope cannot shrink invisibly |
| Unattended success | Independently verified successful episodes with no intervention / eligible episodes | Separate no-human runs from high-quality assisted runs; never treat silence as success |
| Exception burden | Human minutes spent resolving automation exceptions / all eligible episodes | Better recovery and routing; low exception count with hidden failures is worse |
| Notification usefulness | Actionable notifications / audited notifications; interruptions per person-day | Coalesce, suppress superseded signals and show meaningful changes; clicks alone are insufficient |
| Knowledge reuse | Accepted tasks using relevant prior verified artifacts / tasks with such artifacts available | Retrieve decisions and reusable results; penalize stale or irrelevant reuse |
| Failure recurrence | Repeat incidents with an already-known cause / incidents, normalized by exposure | Turn reviewed failures into regression cases and verified repairs |
| Predictability | Deadline calibration and spread of completion time within task classes | Forecast from actual execution history, expose uncertainty; don't reward padded deadlines |
| Improvement yield | Adopted, independently validated improvements / experiments; cost per useful finding | Research-to-experiment loop; failed experiments still count toward cost and learning |

Use the existing two primary outcomes—accepted work per human hour and time to
verified acceptance—with these as diagnostic measures. Select a few per workflow;
collecting everything by default creates cost, privacy exposure and dashboard noise.

## What exists and what needs connecting

Read-only code inspection in this branch found:

- `server/work-wakes.mjs`: transaction-linked work wakes, revision-based
  invalidation, opt-in hosts and policy checks.
- `server/wake-metrics.mjs`: wake counters, suppression/failure accounting.
- `server/work-context.mjs`: current work, claims, verification, decisions,
  handoffs, budget and bounded access descriptions.
- `server/work-handoff.mjs`: persisted envelopes and expiry transitions.
- `server/work-duplicates.mjs`: deterministic lexical duplicate suggestions;
  explicitly no automatic merge or closure.
- `server/work-claim-routes.mjs`: claim sweeps and settlement paths.
- `server/inbox-outbox.mjs`: retry-aware delivery and uncertain-outcome handling.
- `server/receipt-verify.mjs`: public receipt verification.

These are foundations, not proof of complete end-to-end automation. This inspection
is not an exhaustive absence audit. Proposed capabilities below are extensions or
integrations not established as complete by this inspection; inventory relevant
callers and tests before building another implementation.

## Proposed largely automated capabilities

| Capability | Trigger and result | Autonomy / measurable win | Foundation and missing connection |
|---|---|---|---|
| Commitment reconciliation | Plan/decision changes → identify unmapped, contradictory or abandoned commitments | Automatically flag and propose; changes to intent remain explicit. Fewer lost commitments | Work board + delivery ledger; missing source-to-commitment reconciliation with disposition history |
| Work readiness coordinator | Dependency resolves or lease changes → reevaluate readiness and notify/dispatch allowed next step | Deterministic readiness and policy; autonomous dispatch within authorization. Less blocked time | Wakes + dependencies + scheduler; needs bounded due queue and verified state transitions |
| Evidence freshness service | Artifact/dependency revision changes → mark dependent checks stale and run selected verifiers | Automatic internal checks; human acceptance when required. Fewer invalid completion claims | Receipts + revisions; needs dependency-aware invalidation and verifier budgets |
| Review packet builder | Attempt submits result → assemble diff/preview, checks, source decisions and unresolved questions | Mostly automatic; reviewer judges. Less review preparation and missing context | Work context + artifacts + evidence; consistent snapshot and byte budget |
| Recovery coordinator | Attempt stalls/crashes → reconcile effect ledger, resume safe steps or produce precise blocker | Automatic for known recoverable states. Less manual recovery and duplicate work | Session/handoff/outbox primitives; unified operation identity and crash qualification |
| Documentation contract checker | Capability changes → regenerate examples and test supported journeys | Fully automatic checks; suggested prose for ambiguous explanations. Less docs drift | Capability catalog + onboarding probes; shared contract and failed-journey feedback |
| Regression-case builder | Reviewed production failure → sanitized fixture, reproducer and candidate test | Automatic draft, reviewed oracle; then automatic replay. Lower recurrence | Existing test suites; needs safe trace capture and provenance-preserving fixture promotion |
| Research-to-experiment assistant | New relevant paper or version change → source-backed brief, applicability test and bounded experiment proposal | Discovery/deduplication/draft automated; adoption evidence-driven. Higher useful research yield | Research docs + work items; needs source versions, claim tracking and experiment registry |
| Resource optimizer | Repeated equivalent work or budget drift → cache/reuse or compare execution policies | Deterministic caches first; learned routing in shadow mode. Lower cost per accepted outcome | Budgets + receipts; needs scoped cache keys, invalidation and quality-matched comparisons |
| Knowledge maintenance | Source changes or conflicts → identify affected summaries and propose repairs | Detection automatic; interpretation reviewed where ambiguous. Less stale context | Room knowledge + work context; needs provenance graph and deletion propagation |
| Maintenance rehearsal | Dependency/schema change → isolated compatibility, migration and restore tests | Fully automated local/sandbox checks. Lower change-failure risk | Existing suites and recovery; reproducible drill fixtures and comparable reports |
| Quiet project brief | Meaningful work changes → concise state, decisions needed and evidence links | Automatic draft/read view; notification only under configured policy. Fewer status meetings and interruptions | Digest + notifications; outcome relevance and notification usefulness evaluation |

The highest-leverage first combination is readiness, evidence freshness and review
packets. It makes existing work demonstrably easier to complete. Research agents,
resource optimization and broader integrations follow once this loop has usable
outcomes and trustworthy telemetry.

## Shared execution architecture

Persist trigger intent in the originating domain transaction. A queue record has
workflow/version, trigger identity, room and subject revisions, run principal,
capability scope, deadline, cost/step limits and deduplication key. Store IDs and
bounded metadata rather than complete room snapshots.

A bounded worker claims a lease with a fencing token, revalidates current authority
and revisions, executes a checkpointed step and records outcome/evidence. Use the
same domain services as interactive commands. Different workflows may serialize
per subject while independent subjects execute concurrently. Coalesce invalidations;
retain why a run was superseded, suppressed, cancelled or failed.

Use stable logical operation IDs across retries, not newly generated attempt IDs.
For a provider without idempotency or a queryable receipt, an unknown outcome
requires reconciliation before another effect. Retries have backoff, jitter,
limits and a terminal state. Preserve cancellation and control-plane access under
load. Prevent automation loops with causation IDs, bounded trigger depth, cooldowns
and per-room budgets; measure amplification from one source event.

A schedule repairs missed events and handles genuine time conditions. It should
not repeatedly reread the whole room and ask a model whether anything happened.
Semantic classifiers can propose actions; deterministic authority and revision
checks decide whether those actions are admissible.

The UI exposes why a run started, what it can change, outcome/evidence, next action
and pause/cancel controls. Reuse current work and attempt views. There is no need
for a parallel opaque bot inbox. Capability configuration and rollout policy must
preserve the user's existing permissions and authorization requirements.

## Qualification and staged execution

1. Inventory existing paths and record baseline task episodes. Preserve A2/A3
   entity and aggregate work; they are dependencies, not competing priorities.
2. Implement observe-only readiness/evidence decisions over fixed fixtures. Use
   known stale, missing, revoked and resolved cases; manually label ambiguous ones.
3. Connect to the A4 durable due queue, using existing wakes and domain commands.
   Initially execute internal verification and prepare review packets.
4. Test duplicates, reordering, process death, unavailable dependencies, revoked
   access, changed artifacts, cancellation, poisoned retrieved content and trigger
   loops. Require terminal accountable outcomes, not merely no thrown exception.
5. Run a matched or randomized evaluation against the current manual workflow.
   Record net human effort, acceptance, cost and exception burden. Promote each
   workflow independently; maintain an opt-out and reversal path.

Provisional hypotheses: 50% less blocked-work duration, 50% less review preparation,
80% less context reconstruction for supported recovery cases, and positive net
human time saved after exceptions and maintenance. These are not measured forecasts.
For deterministic conformance fixtures require no lost committed work, unauthorized
effects or stale evidence presented as current. Finite passing tests do not prove
zero real-world failure. Set stochastic rollout thresholds after pilot variance
and consequence severity are understood.

Do not autonomously change goals, close wanted work merely because it is old,
weaken tests to make a repair pass, or treat a successful generated test as complete
acceptance. Production changes and external communication remain separately
controlled by the current session's authorization. Full automation is appropriate
for bounded, verifiable work; autonomy should expand with demonstrated reliability.

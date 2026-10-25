# Project Room: verified work as the product

Research checkpoint: 2026-10-18. This extends, rather than replaces, the
[architecture execution plan](ARCHITECTURE-EXECUTION-PLAN.md) and
[frontier infrastructure research](FRONTIER-INFRA-RESEARCH-2026-10-18.md).
The [delivery ledger](DELIVERY-LEDGER.md) preserves outstanding commitments.

## Decision

Build the place where a human states an outcome, people and agents assemble the
necessary context, execute bounded work, and return a result that can be checked
and continued. The central object is a work item with durable intent, dependencies,
authority, attempts, artifacts and acceptance evidence. Conversation is one view
of that work. Every new interface should shorten the path to an accepted result.

The initial competitive arena should be small teams doing software, research and
operational projects with multiple people and agents. Universal superiority over
every specialist tool is neither measurable nor a useful architectural premise.
Our ambitious hypothesis is ten times as many accepted outcomes per human hour
for coordination-heavy workflows, while preserving quality and controlling cost.
We will seek superiority task by task, publish losses as well as wins, and expand
only after the evidence supports it. None of those productivity gains is measured
or established today.

## What to learn from Mintlify

Mintlify treats agent documentation as an executable product journey: discovery,
prerequisites, actions, expected results, recovery and repeatable tests. Its
September 25 guide describes Markdown, indexes, authenticated search and fresh
agent-session testing. Its published URL-discovery benchmark makes navigation
failures observable instead of assuming that a documentation page was useful.
These are vendor-run experiments, with a scope narrower than overall productivity.
Sources: [guide](https://www.mintlify.com/library/how-to-make-your-documentation-agent-friendly),
[benchmark implementation](https://github.com/mintlify/docs-url-discovery-bench).

**Our adaptation:** extend the existing capability catalog and discovery endpoints
into executable task contracts. A contract should declare inputs, permissions,
revision preconditions, output schema, limits, errors, recovery and a checkable
example. Generate human guidance and agent tool descriptions from the same
contract. A human should see useful actions and clear outcomes; an agent should
receive precise arguments and bounded results. This is our design proposal, not
a claim about Mintlify's implementation.

Project Room already has `server/agent-discovery.mjs`, `server/capabilities.mjs`,
`scripts/build-capabilities.mjs` and `scripts/onboarding-probe/`. Audit and extend
these before adding a registry, onboarding service or another MCP layer. Start
with three complete journeys: join and orient; take a work item through a verified
result; resume another actor's interrupted attempt. Each starts with no remembered
URLs or privileged hidden context. Measure failed requests, unnecessary tool calls,
bytes retrieved, active human minutes and final success.

Mintlify's September analytics-agent release also shows a feedback pattern:
interrogate documentation usage and search failures to decide what to improve.
[Source](https://www.mintlify.com/blog/analytics-agent).
For us, failed discovery and repeated command refusals should become deduplicated
improvement candidates linked to traces. Human review decides whether the defect
is documentation, permissions, tooling or the product. Automatically rewriting
instructions from every failed run would amplify agent mistakes.

## Fourteen companies and the patterns worth adapting

Product documentation establishes available mechanisms, not comparative ROI.
The final two columns below are Project Room recommendations and experiments.
No provider subscription or migration is implied.

| Company | Primary evidence and observed mechanism | Adaptation | Tradeoff and deciding experiment |
|---|---|---|---|
| Mintlify | Sources above: discovery, executable documentation and analytics | One capability contract across UI, CLI and agent entry points | Avoid giant context dumps; compare fresh-session task success and retrieval cost |
| Linear | [Agent interaction](https://linear.app/developers/agent-interaction): work-linked sessions, lifecycle states and activities | Work item owns intent; attempts have visible running, waiting, failed and completed states | Activity noise can overwhelm; measure time to identify the next necessary human action |
| Cursor | [Cloud-agent lessons](https://cursor.com/blog/cloud-agent-lessons): executable environments and separable task execution | Separate durable work identity from conversation and disposable execution environment | Parallelism adds cost and conflicts; measure accepted throughput and review burden |
| Cognition | [Verification at scale](https://cognition.com/blog/testing-development): test plans and environment-backed verification | Attach reproducible tests and previews to completion evidence | Passing an agent-written test is insufficient; independent acceptance fixtures must catch regressions |
| Replit | [Secure development practices](https://replit.com/blog/doubling-down-on-our-commitment-to-secure-vibe-coding): checkpoints and environment separation | Make recovery and preview visible parts of the work experience | A code rollback cannot undo arbitrary external effects; test the actual recovery scope |
| Vercel / v0 | [Changelog](https://v0.app/changelog): preview-centered creation and structured interactions | Review the artifact in place, with a specific request for changes | Avoid building a second general IDE; measure review-to-accept time |
| Lovable | [Browser testing](https://docs.lovable.dev/features/browser-testing): real browser actions, screenshots and logs against previews | Verification receipts identify the exact artifact and environment tested | Browser testing is slower and has UI limitations; use targeted checks and record coverage gaps |
| Braintrust | [Datasets](https://www.braintrust.dev/docs/guides/datasets): production examples become versioned evaluation cases | Promote reviewed failures to permanent regression scenarios | Automated graders can reward plausible errors; calibrate against human review |
| LangChain | [Persistence](https://docs.langchain.com/oss/python/langgraph/persistence): checkpoints and separate durable stores | Distinguish attempt execution state from shared project knowledge | Snapshot growth is real; measure checkpoint bytes and recovery cost as history grows |
| Letta | [Memory](https://docs.letta.com/agent-sdk/memory): persistent editable memory and demand-loaded shared context | Decisions and preferences have provenance, revision and explicit scope | Incorrect memories can compound; measure contradiction, correction and deletion behavior |
| Glean | [Sharing and permissions](https://docs.glean.com/agents/concepts/sharing-permissions): execution identity and sharing boundaries | Every context and action request resolves its effective authority | Retrieval caches must respect revocation; test cross-user and changed-membership cases |
| Dust | [Pods](https://docs.dust.tt/docs/pods-overview): shared workspaces and connected knowledge | Shared artifacts and decisions stay with the project across agents | Avoid copying inaccessible external content into broader rooms; preserve source lineage and visibility |
| Browserbase / Stagehand | [Act](https://docs.stagehand.dev/v4/basics/act): programmatic browser actions | Use browser adapters for missing APIs with inspectable action results | Browser UI drift and nondeterminism remain; compare API and browser success/cost for the same task |
| Modal | [Snapshots](https://modal.com/docs/guide/sandbox-snapshots): filesystem and experimental memory snapshots | Benchmark warm environments and resumable execution separately from durable work state | Memory snapshots have expiration and execution limitations; require cold reconstruction and connection recovery |

The most valuable combination is continuous context plus visible execution plus
independent verification plus recovery. A collection of chat panels, connectors
and agent names would not deliver that combination by itself.

## Work backward from the human experience

A person opens a room and can immediately answer: what outcome are we pursuing,
what changed, what needs my judgment, and what can run without me? The default
screen should emphasize the current artifact, next decision and consequential
progress. Detailed logs remain available on demand. A failed attempt should leave
a useful handoff instead of a dead conversation.

A proposed end-to-end journey:

1. Capture an outcome in ordinary language or from an existing issue. Preserve
   source context and propose a short acceptance checklist. Avoid interrogating
   the user about fields that existing project state can answer.
2. Show a compact plan with dependencies and any consequential external actions.
   The human can adjust the result or constraints directly.
3. Execute ready work using scoped authority. Display meaningful state changes,
   artifacts and blockers, rather than every internal action.
4. Present a preview, diff or research result alongside its verification evidence.
   A person can accept, correct or continue it without reconstructing the task.
5. Store the accepted decision and remaining commitments. A new human or agent
   resumes from a bounded, sourced handoff.

Fun should come from responsive manipulation, visible progress, good defaults,
expressive artifacts and a sense of control. Celebration is optional and tied to
real milestones. Extra notifications, cosmetic agent chatter and streak mechanics
must earn their place through user value rather than engagement counts.

## Architecture that supports this experience

Keep one accepting authority per room, with explicit domain repositories and
transaction boundaries. Messages, work items, attempts, artifacts and effects
need independent storage and revisions. A command reads only its declared
references, validates authority and expected revisions, and atomically records
the event, touched entities, receipt and due effects. The event ledger supports
audit and recovery; serving queries use bounded projections.

Build a capability contract layer over these domain services. UI, CLI and MCP
should call the same authorization and command semantics. Compound reads return
a consistent, byte-budgeted packet with source revisions, omissions and cursors.
A compact packet is useful only if the omitted data remains discoverable and
permission checks apply before content is disclosed.

Separate the lifetime of intent, attempts and execution environments. A durable
attempt refers to a versioned context manifest, cancellation state and operation
identities. Disposable runners can restart or move without becoming the owner of
project truth. External actions need idempotent sinks or explicit reconciliation;
a retry checkpoint alone cannot guarantee exactly-once effects.

Use incremental dependencies for derived views and a durable due queue for work.
Ordinary reads should not trigger global sweeps. Build replay generations in
bounded chunks, validate them and publish through a small atomic switch. This
requires design and qualification; schema 41 currently isolates replay but still
has expensive whole-state folding and initial publication.

Adopt new infrastructure only when a measured limitation justifies its operational
cost. We should not introduce a distributed log, a vector database or a new agent
framework solely because a successful startup uses one. The linked research
report records experimental candidates and applicability limits.

## Measurement system and ambitious targets

The two primary outcomes are **accepted outcomes per active human hour** and
**elapsed time to verified acceptance**. The unit is a predeclared task episode,
not a message, token, commit or subtask generated by the agent. Human effort includes
setup, prompting, review, correction and recovery by every participant. Acceptance
requires the original rubric; split tasks retain the original episode identity.

For throughput, sum accepted, predefined task units divided by total human hours
across all assigned episodes, including failures. Report within task classes;
do not blend trivial edits with complex research using invented weights. For
elapsed time, report completion probability by deadline and censored failures as
well as median/p95 among completed episodes. Successful-only latency can hide
abandonment and is never the headline result alone.

Drivers: context-reconstruction minutes and avoidable handoff/tool failures.
Guardrails: escaped defects or rework within seven days, and total infrastructure
plus model cost per accepted outcome. Privacy and lost committed work are hard
release gates, not tradeable score components. Also collect user-rated control
and effort so an efficiency win does not conceal an unpleasant product.

| Hypothesis, not current achievement | First meaningful gate | Stretch goal | Why / measurement |
|---|---|---|---|
| More accepted work per human hour | 2x in the initial task cohort | 10x in coordination-heavy workflows | Controlled comparison including review and rework |
| Shorter elapsed time to acceptance | 30% reduction | 80% reduction | Same task difficulty and quality; include unfinished episodes |
| Less context reconstruction | 50% fewer active minutes | 90% fewer | Observe handoffs and source-seeking behavior |
| Reliable fresh-agent onboarding | 90% on a fixed supported suite | 99% | Repeated clean sessions, versioned models and environments |
| Faster local interaction | p95 acknowledgment under 100 ms on named devices | Under 50 ms | Distinguish immediate UI feedback from durable server acknowledgment |
| Bounded entity operations | Under 10% latency growth from 10k to 100k unrelated records | Same at 1m | Hold touched entities fixed; measure p95, CPU, bytes and queries |
| Bounded replay publication | Under 10 ms local switch after preparation | Stable across generation size | Separately measure total rebuild CPU, duration and storage |
| Recoverable attempts | Every injected supported crash resumes or reports a precise terminal state | Zero manual context reconstruction in recovery suite | Fault injection at every persistence/effect boundary |

These targets are top-down product hypotheses. We lack comparative user-study
baselines, workload distributions and production percentiles needed for credible
forecasts. The schema 41 local 100k edit result is approximately 0.409 ms versus
44.779 ms previously, but the full replay still took 286.4 seconds. Neither number
establishes end-user productivity. See the
[measurement checkpoint](MESSAGE-REPLAY-ISOLATION-PLAN.md).

METR's early-2025 randomized study involved 16 experienced developers and 246
real repository tasks; allowing contemporary AI tools increased completion time
by 19% in that setting despite perceived benefits. It does not establish the
performance of 2026 tools or Project Room. It establishes why subjective speed
and compelling demonstrations are insufficient evidence.
[Primary study](https://metr.org/blog/2025-07-10-early-2025-ai-experienced-os-dev-study/).

Run paired task variants with counterbalanced tool order, equivalent onboarding,
identical resource access and independent rubric review. Include the user's
existing workflow, a strong specialist workflow and Project Room with the same
model where possible. Record tool/model versions and distinguish orchestration
gains from model upgrades. Start with a pilot to estimate variance and task
learning effects; use that estimate for a powered study. Preregister exclusions,
primary comparisons and minimum meaningful improvements. Bootstrap at the
participant/project level rather than pretending repeated actions are independent.
Keep failure episodes, uncertainty intervals and qualitative observations.

## Execution priorities and explicit choices

| Option | Decision | Why / why not now |
|---|---|---|
| Complete entity boundaries and aggregate separation | First implementation priority | Removes the central change bottleneck and enables durable attempts without adding more blob state |
| Executable discovery and three complete task journeys | Next product slice, instrument alongside architecture | Fast feedback on whether the rebuilt foundation helps humans and agents |
| Durable attempts, context manifests and verification receipts | Core differentiation after boundaries | Combines continuity, evidence and recovery; needs transaction and authority contracts |
| Generation-based replay and incremental views | Prototype against current costly replay | Large measured opportunity; complexity must earn its place with parity and recovery tests |
| Broad connector marketplace or general autonomous browser platform | Preserve as evaluated extension, do not build wholesale now | High support burden; start with adapters demanded by the three journeys |
| Replace SQLite or distribute every room immediately | Experiment only if limits demand it | New storage does not fix oversized aggregates, invalidation or missing acceptance evidence |

The next coding prompt is: finish the transaction-scoped message entity context,
return explicit touched outputs, preserve authorization/idempotency ordering,
and differentially compare every supported command against the current reducer.
Include rejected commands, cross-domain references and reversal. Prove that
unrelated history is not serialized. Then apply the boundary to work, attempts
and artifacts. This is the critical path; attractive research must not displace it.

## Development and research operating system

Every planned item has a stable ID, dependencies, owner role, acceptance evidence
and an explicit status. Research introduces hypotheses and experiments, not silent
requirements. Accepted commitments stay visible until completed or superseded
with a written reason and replacement ID. A checkpoint is not a release, and a
local passing suite is not production qualification.

Each implementation slice starts from an observed user failure or architectural
constraint, specifies invariants and measurements, changes one coherent boundary,
and records a reproducible comparison. Preserve representative production failures
as sanitized fixtures; use independent acceptance cases for agent-generated work.
Maintain deterministic crash/retry schedules and a full-recompute reference for
incremental projections. Remove compatibility paths only after consumer cutover
and reversal evidence is recorded.

Review new papers and primary implementation discussions against a fixed template:
problem, assumptions, mechanism, evidence, failure modes, workload fit and cheapest
falsifying experiment. An experiment has a bounded budget and a stop rule. A failed
experiment remains useful evidence. This document does not establish a scheduled
research automation; cadence belongs to the development process unless explicitly
scheduled later.

The ledger below is the durable continuation point. It preserves all seven stages
of the current architecture plan and the additions from these research passes.
It does not claim a complete audit of every historical chat or every older plan;
reconciling those sources is itself an explicit outstanding item.

# Agent utility: product options and trials

Status: research hypotheses, not an approved product boundary or evidence of
customer demand. Existing rooms, Docs, runners and source catalogs are reusable
assets. None determines what the product must become. This brief describes how
to select the next implementation by observed benefit to people using agents.

## Product promise to test

Give an existing agent a capability it lacks, let it produce a useful result
quickly, and preserve enough context and evidence to use that result again.
The customer need not replace their preferred agent, migrate their team or
create a room before receiving value. A single-agent customer must benefit.

The leading hypothesis is a service for completing and resuming useful work
across tools and sessions. That is a hypothesis, not a commitment to build an
all-purpose agent platform. Context access, execution, verification and reusable
capabilities are competing entry points as well as potential complements.

## Alternatives worth testing

| Direction | Concrete user job | Reuse candidate | What would justify choosing it |
| --- | --- | --- | --- |
| Durable work | Continue an interrupted multi-step job without repeating completed external actions | [Temporal](https://github.com/temporalio/temporal), [LangGraph](https://github.com/langchain-ai/langgraph) | Fewer abandoned jobs and interventions, with affordable operation |
| Current project knowledge | Answer what changed, why, and which decision still applies across documents and code | [Graphiti](https://github.com/getzep/graphiti), ordinary indexed retrieval as control | Better evidence-backed answers than simple search, after ingestion cost |
| Tools and environments | Complete an authorized browser-only task or run a reproducible validation job | [Browser Use](https://github.com/browser-use/browser-use), [Agent Sandbox](https://github.com/agent-infra/sandbox) | Unlocks a job the user's agent cannot otherwise complete reliably |
| Shared execution workspace | Hand a real artifact between people and heterogeneous agents with explicit ownership and results | [Buzz](https://github.com/block/buzz) | Measurably less manual forwarding and recovery, including one-agent use |
| Verified reusable capabilities | Find, evaluate and integrate an existing implementation of a difficult feature | Source library plus upstream packages and their tests | Faster verified integration with less maintenance than building afresh |
| Outcome-specific service | Turn one recurring task, such as a sourced research brief or tested bug fix, into a finished deliverable | Select components after choosing the job | Users return for the outcome without needing to understand the infrastructure |

Repository existence establishes an implementation lead, not a winning product
or an independently verified reliability claim. Root licenses are not a review
of every file, asset, dependency or commercial service.

## What the sources establish

Temporal documents durable workflows and retries. It is a candidate for recovery
infrastructure; application actions still need idempotency and reconciliation.
Do not promise exactly-once external effects because a workflow engine is used.

Graphiti documents incremental temporal graphs and hybrid retrieval. Its graph
backend and model inference requirements are material costs. Compare it with a
small index and explicit source revisions before adding graph infrastructure.
Extracted facts remain derived assertions, not authority over source records.

Browser Use exposes library and CLI paths, with local and cloud browser options.
Its documented domain controls are not a hostile-code sandbox. A trial must
separate tool utility, runtime isolation and credential handling.

Buzz describes a shared event model for human and agent activity. Previously
inspected canvas source is pinned in the source library. Its current README also
points to [Buzz 1.0](https://github.com/block/buzz-app); evaluate that successor
before treating the older repository as its current architecture. That successor
has not been source-qualified by this brief.

## First experiments

Use the same task inputs, permissions, agent/model version and success rubric
for a baseline and candidate. Alternate order and use fresh sessions to reduce
learning effects. Keep setup cost separate but include it in first-use results.
Start with these three trials; do not build all six product directions at once.

1. **Resume a useful job.** A task reads inputs, produces an artifact and writes
   to a disposable test destination. Interrupt before a write, after a committed
   write with a lost response, and before final verification. Resume from another
   agent session. Check destination state independently: no duplicated effect,
   no false completion, and a usable final artifact. Compare manual restart with
   durable execution. Record recovery time, interventions and total cost.
2. **Recover the right context.** Supply a bounded corpus containing superseded
   decisions, renamed documents, conflicting assertions and access restrictions.
   Ask for current facts with citations and for one historical answer. Compare
   plain search with structured retrieval. Score against a human-authored answer
   key; report unsupported assertions and forbidden-source exposure separately.
3. **Reuse code to solve a real problem.** Choose one feature with an executable
   acceptance test. Compare an upstream adaptation with a from-scratch solution.
   Count time through passing verification, integration changes, dependencies,
   attribution completeness and an upstream-update exercise. A source bookmark
   or passing upstream tests alone does not count as an integration.

Run initial technical trials on synthetic/disposable data. Then use consenting
users' real tasks to test whether the capability matters. Internal fixtures can
disprove reliability claims; they cannot establish willingness to adopt or pay.
Do not manufacture extra tasks just to keep workers busy.

## Agent discovery and first-use design

Expose the same operations through a small typed tool surface, CLI and HTTP,
with semantic keyboard-operable UI as another client. Return compact capability
metadata: useful job, input schema, permissions, expected output, cost bounds,
side effects, current availability and recovery path. Retrieve detailed examples
only when selected. A capability directory should support search by problem,
not require the agent to learn internal module names.

Offer a useful read-only example before account setup where practical. For real
data, request only the needed connection and scope. Return stable artifact IDs,
source revisions, explicit incomplete states and actionable errors. Include
export and cancellation. Measure first useful result from initial discovery,
not merely connection success. An agent host must actually expose the tools;
publishing Markdown or an MCP endpoint does not guarantee automatic discovery.

Growth should follow useful artifacts: a recipient opens a result, understands
its evidence, and can continue it with their own agent. Let users publish reusable
capabilities and examples deliberately. No unsolicited agent recruitment or
automatic disclosure of private context. Track whether another user actually
gets a useful result, not how many invitation messages were sent.

## Measurement and decisions

Use only three primary measures for the first Docs workflow:

| Measure | Definition | Decision |
| --- | --- | --- |
| Verified completion rate | Attempts meeting the task's predeclared acceptance rubric before its time budget / all started eligible attempts | Keep or remove the change based on whether more people finish the job |
| Time to verified result | Elapsed time from task presentation, including setup and recovery, to independent acceptance; report completed-task median alongside failure/timeout counts | Remove steps, waiting and repeated context loading without hiding failed attempts |
| Human intervention | Human active minutes and rescue actions per started attempt, excluding the initial instruction and planned acceptance check | Reduce manual forwarding, clarification and repair |

Guardrails: zero observed unauthorized disclosure or destructive lost updates;
report model/service cost per attempt when known, otherwise mark unavailable.
A passing guardrail test is evidence for that case, not proof of zero production
risk. Compare the same task mix and fixed time budgets across versions. A timer
on a unit test is not user task latency. Fixture results and real user results
must stay separate. Baselines and numeric improvement targets are not yet
established; report raw observations before setting a target.

Before adding or retaining a control, message, document or subsystem, ask what
fails if it is removed. Keep correctness-critical mechanisms; compare a simpler
variant for the rest. Remove an element when the simpler variant preserves
completion and guardrails while reducing time, intervention or maintenance.
No extra dashboard, event pipeline or mandatory user questionnaire is required
for the first comparison: a compact per-attempt record and existing test evidence
are enough. Feature count, lines copied, agent messages and tests passed are
not primary product outcomes.

For each attempt record trial ID, task/input revision, arm, agent/runtime version,
source pins, start/end, success evidence, cost where observable, human active
minutes, intervention count, duplicated effects, unsupported assertions and
access-control failures. Unknown costs remain unknown; failures stay in the
denominator. Report raw counts and paired differences before aggregate claims.

Advance a candidate only if it improves a user-relevant outcome without a
material regression in correctness, permissions or total cost. Predeclare the
minimum worthwhile improvement for the selected task before running it. Repeat
on a second task and a different agent host before claiming portability. Small
samples guide the next experiment; they do not prove general superiority.

Stop or change direction when setup exceeds the saved effort, users do not need
the capability again, a simple existing tool performs equally well, or ongoing
maintenance exceeds the demonstrated benefit. Favor a maintained dependency or
service boundary over a fork when it preserves the required behavior. A broad
replacement remains an option when the measured value warrants it.

## Immediate execution split

- Local implementation lane: source inventory and this trial protocol; qualify
  one upstream candidate at an immutable revision before integration.
- Peer implementation lane: finish the bounded Docs reader/editor fixture and
  provide portable source plus executed save/conflict/navigation evidence.
- Joint checkpoint: independently reproduce the selected artifact, record gaps,
  and decide whether its benefit warrants product integration. Completion of a
  fixture is not completion of the product, proof of deployment or a pivot vote.

The existing Docs work can finish as a reusable capability while these options
remain open. No experiment here starts a schedule, changes release ownership,
or requires importing a whole upstream product.

# Agent utility: product options and trials

Status: research hypotheses, not an approved product boundary or evidence of
customer demand. Existing rooms, Docs, runners and source catalogs are reusable
assets. None determines what the product must become. This brief describes how
to select the next implementation by observed benefit to people using agents.

## First-principles reset — 2026-11-12

The latest request is to question the whole concept and pursue a substantially
better human product. Existing code, chat-first direction and past plans are
assets and hypotheses, not reasons to retain a feature. The previous small-team
task-to-reviewed-PR audience is a starting comparison, not an unchangeable market.

| Candidate product | First useful outcome | Strong incumbent/control | Evidence that rejects it |
| --- | --- | --- | --- |
| Shared project state and continuation | A different existing agent continues correct work without reconstructing chats | GitHub plus concise repository guidance | Setup/retrieval costs exceed saved reconstruction; one-agent use adds no benefit |
| Human decision and review workspace | A person sees what changed, evidence and the next decision clearly | Linear/Codex/GitHub review | More navigation, weaker visual hierarchy or no improvement in review correctness/effort |
| Agent execution coordinator | An authorized multi-step task survives interruptions across hosts | Existing agent host plus ordinary scripts/CI | Coordination and operating costs exceed saved failures; no unique completed job |
| Project knowledge service | Correct source-grounded answer or decision reuse | Repository search and maintained Docs | Retrieval is stale, costly or no better than simple search |
| Outcome-specific contributor service | A new contributor ships a reviewed useful change with little setup | GitHub issue/PR and their preferred agent | Required Room adoption delays value or accepted work does not repeat |

Leading synthesis to test: durable shared project state with excellent human
review/decision surfaces, accessible to agents through fast structured tools and
to outside contributors through existing GitHub workflows. It need not own every
chat, agent runtime, design canvas or CI worker. This is a recommendation to test,
not validated demand or a reason to build all candidate products.

Audit each mechanism by asking: whose current job gets easier, what is the
competent simpler alternative, what happens if we delete it, what evidence could
reject it, and what are the ongoing setup, privacy, review and operating costs?
Keep the source of a fact distinct from the interface presenting it. Preserve
working security/recovery behavior while replacing weak interaction structures.

The next comparison must include a fresh contributor and a returning reviewer,
a real human-account session, an existing agent tool path, and an interruption.
Compare a coherent project/task-led human flow with the current conversation-led
flow on the same content. Visual craft is a required part of the candidate:
type, spacing, density, focus, navigation and state design. Screenshots alone do
not prove comprehension, and functional tests alone do not approve the design.
Keep or reject the integrated result using the existing scorecard, not feature
count, task volume, device utilization or an agent's taste score.

### Concept audit: what actually deserves to exist

Start with a person's unfinished job, not a room, agent team or software factory.
The proposed job is: **get a worthwhile change completed, understand whether to
trust it, and let the next contributor continue without reconstructing history**.
This is a testable choice of job, not established customer demand. A solo user
with one agent must be able to benefit; multiple agents are an optional execution
arrangement. Other project types remain possible, but adding audiences before
one workflow works makes the result harder to evaluate.

Current evidence is narrower than our ambition:

| Observation | What it supports | What it does not establish |
| --- | --- | --- |
| Local human-account journey captures at PR6143 head 3da3047ad repeat the task title across search, results and work; a return control overlaps message context | The current hierarchy needs structural improvement, even though the captured states have no serious automated accessibility findings | Which replacement people understand or prefer |
| Eighty existing identity-boundary checks, one explicit credential-conversion check and four real human-account browser cases passed locally | Human account and agent principal boundaries can be exercised independently of appearance | Exhaustive security, production behavior or a good human interface |
| A laptop-targeted request received a cloud-session response before the intended laptop replied | Shared member identity alone cannot establish runtime delivery | That faster server writes solve host activation or execution |
| Nine synthetic continuation inputs exist, with zero recorded participant episodes | We have repeatable technical probes ready | Demand, retention, willingness to pay or superiority over incumbents |

The captures and local trial records are private evidence artifacts, not files to
publish into the repository. Preserve their source revision in any comparison.
Passing checks protect working behavior; they do not settle the product choice.

### Three distinct product bets

1. **GitHub companion.** Attach current context, acceptance evidence and a
   resumable next action to existing issues and PRs. Contributors keep their
   agents and normal tools. This has the smallest adoption requirement and is
   the first control to test. Its weakness is becoming a redundant summary bot:
   reject it if a concise issue template and repository guidance work as well.
2. **Project and review workspace.** Give people a well-designed view of current
   work, results and decisions, with conversation attached to the relevant work.
   Give agents compact structured access to the same authorized state. This is
   the leading integrated candidate because it addresses both continuity and
   human judgment. Its weakness is asking a team to adopt another destination:
   reject it if additional navigation offsets the saved effort.
3. **Execution service.** Own durable dispatch, interruption recovery and
   heterogeneous local/cloud execution. It could complete jobs existing hosts
   cannot finish reliably. It also has the greatest credential, isolation,
   availability and operational burden. Expand it only for a demonstrated job
   the first two options cannot serve; keeping laptops busy is insufficient.

These are competing investments, not three new modules to build simultaneously.
Knowledge, design tools and reusable upstream code earn investment by improving
the chosen job. A generic wiki, marketplace, social network or orchestration
platform is not an automatic consequence of having related components.

### Deletion and simplification candidates

| Current assumption or mechanism | Simpler candidate to evaluate | Preserve |
| --- | --- | --- |
| Conversation must be the home for all projects | Project work and decisions as the human home; conversation in context | Existing links, attribution, drafts and history |
| Joining Room precedes contribution | Public task/result link and GitHub-only contribution; connect when it unlocks an action | Explicit authorization and private-source boundaries |
| More agents and occupied devices mean progress | One agent by default; bounded parallel work only when interfaces and resources permit | Useful independent review and deterministic checks |
| Every update needs another message | Update the linked task/result/check state; notify for a decision, failure or meaningful change | Direct messages as an option and inspectable history |
| A universal assistant voice is necessary | Show the responsible person or agent and the actual artifact | Clear ownership; no invented consensus or activity |
| Docs should copy every source | Keep project decisions and procedures where useful; reference authoritative GitHub and external revisions | Searchable current context, provenance and access control |
| Human UI mirrors every backend capability | Few primary actions with progressive detail and stable task navigation | Fast complete agent tools and accessible human controls |

These are audit candidates, not permission to delete live records, remove
security boundaries, or break published integrations. Remove a mechanism when
its replacement serves the same needed job with less total effort.

### Smallest complete workflow to compare

Use one real bounded change through this sequence:

1. **Find:** open the project or shared task and identify the intended outcome,
   current source, acceptance condition and authority. No chat archaeology.
2. **Start:** a permitted contributor claims the scope. Existing scripts enforce
   revision/permission/conflict rules; the contributor resolves ambiguous goals.
3. **Produce:** their preferred agent or human creates the change in an isolated
   workspace. Ordinary tools run deterministic checks and attach exact-source
   results. An unavailable worker stays unavailable, not implicitly working.
4. **Review:** a non-author sees the artifact, change, evidence, uncertainty and
   available decision together. Design changes include rendered states and a
   human usability judgment, not merely passing code checks.
5. **Deliver:** existing authorized merge/deploy machinery records the actual
   released revision and verification. Submission, acceptance and production
   remain separate facts; unknown external effects require reconciliation.
6. **Continue:** the next session retrieves current work and the next useful
   allowed action, with relevant decisions and source links. A conversation or
   handoff prompt is generated only when useful, not another mandatory form.

Compare the existing GitHub-and-agent path, the GitHub companion, and one
coherent task-led human prototype on matched content. Do not implement a broad
navigation migration before observing the prototype. Begin with a contributor
and a returning reviewer; repeat across independent people and tasks before
making comparative claims. John is arranging outside participants; none have
completed a recorded episode yet.

Use the existing scorecard and offline episode recorder. Include setup, failures,
review, recovery and removal of the integration. Keep only a candidate that
reduces elapsed time or total human effort without lowering accepted completion
or violating guardrails. A small pilot can reject obvious friction; it cannot
establish a reliable population effect. If Room adds no benefit over the simpler
control, narrow it to the useful integration or stop that direction.

### Competitive implications, not performance claims

[Linear's agent platform](https://linear.app/docs/agents-in-linear) already
supports issue delegation, mentions, scoped installations and versioned Markdown
guidance. None of those capabilities alone differentiates Room. Its documentation
does not establish a response-time baseline for our intended runtime pairs.
[Buzz's successor app](https://github.com/block/buzz-app) is a relevant open-source
implementation to inspect, not evidence that adopting its code produces demand.
Any reused slice needs a pinned source, license review, concrete acceptance test
and an update/removal path in the existing source library.

The defensible opportunity to test is less reconstruction and manual forwarding,
clearer human decisions, and reliable continuation across existing agents and
tools. We must demonstrate that on completed work. Faster messaging, more tools,
a large wiki and polished screenshots are supporting mechanisms, not the value
proposition by themselves.

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

## Active MVP trial — 2026-11-12

Decision: find the smallest workflow that lets a small software team complete a
bounded task to a reviewed PR and then resume useful work. Use the
[active scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md#active-mvp-scorecard--2026-11-12)
for the primary metrics, denominator and uncertainty rules. These are trials to
run, not adoption results or a requirement for every contributor to fill a form.

| Slice | Concrete procedure | Acceptance and diagnostic |
| --- | --- | --- |
| First useful action | Start from the same public task or GitHub issue in a fresh authorized host session. Let the contributor choose GitHub-only or connected Room entry. Observe the first wrong turn before offering help. | Finds the intended task and scope, identifies permission and ownership, and performs one useful allowed action. Record elapsed time and each manual rescue; connection alone is not success. |
| Review clarity | Give a non-author the exact artifact and existing evidence, without the author's chat. Ask what changed, what is verified, what remains uncertain and which decision is available. Exercise the rendered result at desktop and phone sizes. | Correct artifact/review distinction and an actionable accept/change/insufficient-evidence decision. Record clarification requests and active review minutes. Keep automated checks separate from design acceptance. |
| Continuation | Use the existing stale-source, unfinished-edit and unknown-write fixtures. Compare repository evidence, handwritten handoff and generated continuation with equal accessible source evidence in fresh sessions. | Correct next action, no invented test execution, preserved drafts and no replay of an uncertain write. Record reconstruction effort; do not reuse a participant's answers across arms. |
| Routine checks | Execute the existing pinned local affected-unit recipe on a changed source that actually needs it. Independently inspect the run record and exact source; exercise timeout or changed-source refusal through existing tests. | A verified run or honest refusal, no model calls inside the deterministic check. Count failed attempts, setup and recovery; do not manufacture jobs to keep devices busy. |
| Repeated value | After a project's first accepted real outcome, observe whether it completes a second meaningful outcome within seven days. Link existing task/result IDs. | Matured seven-day projects only in the denominator. Projects still inside the window remain pending. Do not substitute a second scripted fixture, invitation, hello or check rerun for repeat customer value. |

Use two bounded task classes initially: a small bug fix and a small interface
change. Compare the participant's existing GitHub-and-agent workflow against the
Room-assisted path using matched scope, starting permissions, source and review
rubric. First use and returning use are separate cohorts. Alternate order across
participants; repeated exposure to the same task is a learning effect, not a clean
comparison. A 30-minute episode deadline is a provisional pilot budget, not a
claimed product performance target. Set it before the episode starts.

The first worthwhile benefit to test is eliminating one avoidable manual rescue
or clarification while preserving completion and review quality. With no baseline,
this is a hypothesis. Keep raw observations and counterexamples; a few episodes
do not establish superiority over GitHub, Linear or another agent workflow.
Technical fixture results can reject a mechanism but cannot establish human
usability, demand or retention. Record native-host connection gaps explicitly.

### Run the existing evidence tools

```sh
# Generate one participant input. Keep evaluatorOnly fixture keys separate.
node scripts/prepare-continuation-trial.mjs stale-source generated
# Capture actual result discovery/reading and current/stale continuation views.
node scripts/design-evidence-gallery.mjs --journey results --out /absolute/new-results-directory
node scripts/design-evidence-gallery.mjs --journey continuation --out /absolute/new-continuation-directory
# Summarize recorded episodes at an explicit reporting cutoff; no service writes.
node scripts/summarize-outcome-trials.mjs /absolute/records.json 2026-11-12T12:00:00Z
```

The offline summary input is `{ "schemaVersion": 1, "episodes": [] }`. One
started episode uses `outcomeId`, `taskClass`, `actorType`, `actorId`, `condition`
(first-use/returning), `arm`, `sourceRevision`, `rubricRevision`, `startedAt`,
`deadlineAt`, `status`, `humanMinutes`, `costUsd` and `guardrailFindings`.
Measurements and findings are `null` when unobserved. An observed absence of
findings is `[]`; it is not a universal safety claim. Supported statuses are
running, accepted, failed, abandoned and cancelled. Accepted records also need
`artifactRevision` and an `acceptance` with `at`, `reviewerId`, matching
`artifactRevision` and matching `rubricRevision`. Set `independentReviewRequired`
when the task requires it. `evidence` may link existing check/PR/task records.
Use a distinct taskClass for synthetic trials and actual user tasks.

The command rejects duplicate outcome IDs, stale review references, impossible
observation windows and severe guardrail failures marked accepted. It preserves
late acceptance, pending ages, immature early successes and measurement coverage.
It does not infer task success, human effort, cost or safety from test durations.
Maintain these compact records with the trial evidence; this is not a new product
analytics service, participant questionnaire or automatic background schedule.

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

The [active MVP scorecard](QUALITY-AND-PRODUCTIVITY-SCORECARD.md#active-mvp-scorecard--2026-11-12) defines the current cross-product measures. The three definitions below remain the narrower first-Docs trial protocol; keep their populations and human-effort exclusions explicit when comparing results.

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

# Agent-first work, with a small human view

Comparison checkpoint: November 16, 2026 UTC. The initial comparison used
`8f1caea3cecacb1e756911dc3800a253e36bbcf3`; the follow-up source audit below uses
merged checkpoint `84027d7c2`. These are dated baselines, not current deployment
discovery. This is a primary-document/source
comparison plus a real Room contribution trial, not a timed cross-product test.
Competitor features below are documented behavior, not independently qualified
on this Mac. Missing evidence is not evidence that a competitor lacks a feature.

## Decision

Design the agent contract first: an authorized assignment, bounded relevant
context, a current next action, a saved result, correction, exact review and
acceptance. Agents use MCP, HTTP or stdio directly. A browser must not be a
prerequisite for picking up or returning work. Human views should expose the
outcome, current result, blockers and decisions from those same records.

Room already has that storage and authorization foundation. A wholesale UI or
backend rewrite is not justified by this comparison. The worthwhile overhaul is
to make one supported machine path the default and keep the human surface small.
Do not replace SQLite, introduce another queue or rebuild a fleet dashboard.

## What the references teach us

| Reference | Concrete mechanism | What Room should use | Boundary |
| --- | --- | --- | --- |
| Linear | API/webhook agent sessions, typed activities and relevant `promptContext`; distinct agent identity | Clear invocation, contextual handoff and honest lifecycle; compact human progress | Its UI-native interaction guidance does not require agents to operate a browser |
| Block Buzz | JSON CLI and MCP tools; saved logical session associations before execution | Discoverable machine commands, exact operation inputs, explicit source/session scope | Its desktop/relay/plugin architecture is much broader than this one-room goal |
| Beads | `ready`, atomic claim, structured task inspection and durable dependency state | A short pickup loop and one source of current task truth | Its Dolt graph/storage/sync system is not needed to retain Room's task semantics |
| GitHub Copilot cloud agent | Assigned issue/context becomes repository work and a reviewable PR | Make accepted output the product, with source/check evidence and a correction path | Coding-specific managed execution is not a substitute for arbitrary existing hosts |

Linear's activity history is documented as the reconstruction source because
ordinary comments can be edited. Room should retain exact result/version evidence
and distinguish requested, received, started and accepted. Linear's session plan
API is technology preview; a useful example, not a dependency or settled contract.
[Agent interaction](https://linear.app/developers/agent-interaction),
[best practices](https://linear.app/developers/agent-best-practices),
[interaction guidelines](https://linear.app/developers/aig).

Buzz explicitly makes the CLI an agent-facing surface with JSON output, structured
errors and distinct conflict/auth/network exits. Its local association design
keeps logical session identity over reconnects and rejects retired-lifetime
requests. These are useful invariants, not a reason to import its entire runtime.
The newer app also offers a local tool helper to agents it did not start; that
is worth studying for a future supported existing-host connection, with its user
and sandbox limits intact. Its remote-agent document is explicitly a draft.
[CLI](https://github.com/block/buzz/blob/75d78eab68416d9144e1075f84c061d4f406cde8/crates/buzz-cli/README.md),
[agent/session contract](https://github.com/block/buzz-app/blob/3fca4520a53dc5618c908361e332b84ff45dba6a/docs/agents.md),
[remote draft](https://github.com/block/buzz/blob/75d78eab68416d9144e1075f84c061d4f406cde8/docs/remote-agents.md).

Beads makes ready work and taking responsibility first-class machine operations.
Its documentation also records HTTP divergences and unknown-write outcomes rather
than pretending every backend has identical guarantees. Reuse that discipline:
cache context, never authority; retain immutable input for ambiguous retries.
[Beads source](https://github.com/gastownhall/beads/tree/8cdfa796a8f571266f2687f8b80365cbe26a943d).
GitHub supplies initial issue context to its cloud agent, then uses the PR for
follow-up work; later issue comments are not automatically included. Room should
make the current discussion/result boundary equally explicit.
[GitHub task flow](https://docs.github.com/en/copilot/how-tos/copilot-on-github/use-copilot-agents/kick-off-a-task).

## Room's measured friction and changes

The real signed-in Claude Code runtime received one bounded read-only task in
the existing room, submitted evidence, received an independent Codex correction,
submitted a corrected result, and obtained delegated owner acceptance. This
proves that path actually ran. Acceptance was performed under the owner's
standing delegation; it is not a claim that the owner personally reviewed it.

The trial retained failures: a bespoke shell helper added an unsupported pickup
argument, a host allowlist blocked a later shell attempt, an initial brief omitted
source text by design, and a first report exceeded the native text-evidence limit.
The native MCP path then completed without a browser. Independent review rejected
an overstated routing concern before accepting corrected findings. These failures
are reasons to use discovered tools/schemas directly and state result limits early.
No before/after task-time baseline exists; no agent speed or quality win is claimed.

Changes based on that evidence:

- Repeat `room_read_work` brief reads accept a retained `knownBriefVersion`.
  They recompute authorized current context and continuation. If the scoped brief
  is identical, they omit repeated text; otherwise they return the full brief.
  Exact result/discussion preparation cannot use the shortcut. Omitted content is
  not certified unchanged. No authority or stale result is cached.
- One `nextWorkStep` value feeds the card's status and action presentation. Existing
  action eligibility still comes from current `workActions`; no permission is added.
  Legacy handoffs can use the current room owner fallback; current handoffs retain
  their explicit triage member.
- The human card shows a bounded finish condition and current result summary next
  to the next action. Full evidence and version details stay available. The task
  form prompts for output, allowed scope, checks, producer and reviewer.
- The existing source-observation and discussion checkpoints remain the way to
  avoid resending unrelated history. Do not create a second context store.

## Open-source reuse

`client/operation-metrics.mjs` adapts Buzz's actual percentile calculation, bounded
sample buffer and numeric request-summary approach. It records fixed operation
labels, durations, response sizes and failures; no text, identifiers, URLs or
credentials. It defaults off and creates no timers, observers, network or storage.
It is used for local qualification, not as a new product dashboard. See
`third_party/buzz-metrics/NOTICE`, its Apache-2.0 license and `THIRD_PARTY.md`.

Retain Room's existing Buzz-derived signal-log code rather than import it again.
Session admission/tool-operation modules were inspected but not imported: their
native client, plugin and authority bindings are coupled to Buzz. Useful invariants
are recorded above; copying them unadapted would not preserve Room's security.
The earlier pinned Buzz client research remains valid evidence, not an active
instruction to revive matching, search or peripheral feature expansion.

## Acceptance for the next slices

Consistent useful results are primary, with time and context savings supporting
that goal. [The core workflow](CORE-WORKFLOW.md#quality-and-consistency) owns
proportional review, correction and evaluation of rework/reopened work/later
regressions. Native connection instructions use the default complete-work catalog;
the full catalog remains optional.


One real contribution must complete without a custom per-task shell helper or
browser. Measure onboarding corrections, failed calls, useful accepted output,
review corrections and requester interventions separately. Report failure latency
as well as success. Compare matched tasks before claiming faster execution.

Keep the task's output, scope and check criteria explicit before starting; missing
scope is a blocker to resolve, not permission to guess. Use default core tools,
selected reads and retained brief versions. A context fingerprint is not a grant,
a wake is not execution, and a result is not independent acceptance.

## Make each contribution easier to continue

Design follow-up requested by John on November 16, 2026. This section records
recommendations grounded in source checkpoint `84027d7c2`; it does not claim
these recommendations are implemented, deployed or assigned. The current scope
in [FOCUSED-DELIVERY-PLAN.md](FOCUSED-DELIVERY-PLAN.md#current-scope-and-cuts)
still applies. [CORE-WORKFLOW.md](CORE-WORKFLOW.md) owns operating procedure;
live work records own assignments. This is the existing design document, not
another execution backlog.

### Product thesis

Every useful contribution should leave the project easier to continue. Room
should carry the current goal, relevant decisions, exact contribution evidence
and the next authorized action across agents and interruptions. A new agent
should obtain a small current view, understand why a contribution matters and
start useful work without reconstructing a conversation. A returning agent
should see material changes and unresolved obligations. A continuous agent
should retain its context without repeatedly downloading it.

The right unit of progress is an accepted useful outcome, with the appropriate
evidence of integration and operation for that outcome. A design task can finish
with an accepted design; an investigation can finish with a supported conclusion.
A task to ship working software needs evidence from the intended environment.
Do not impose a deployment stage on every task or treat repository merge as
proof that a product requirement works.

### Source audit: preserve the foundation, reconcile the reads

| Observed source at the checkpoint | What it establishes | Remaining question or limitation |
| --- | --- | --- |
| [`src/workflow.js`](../src/workflow.js), `nextWorkStep` and `workActions` | Current task state determines the next role/action; permission eligibility is separate; review and acceptance bind to exact evidence | This explains one item's lifecycle, not the relative value of all project work |
| [`src/work-selectors.js`](../src/work-selectors.js), `needsAttention`, `contributionSteps`, `currentResult` | Existing member-specific attention, review/decision-first presentation and current accepted-result selection | Reuse these semantics rather than create another task engine; prove parity on the supported storage path |
| [`server/available-work.mjs`](../server/available-work.mjs) | Board availability checks unmet dependencies and supersession; accepted work is mapped onto board records | Some legacy callers catch a board read failure as an empty list. A future pickup answer must preserve unknown versus verified empty |
| [`server/work-item-board.mjs`](../server/work-item-board.mjs) | Work/result gates map onto board state; board-native CI/deploy enrichments are preserved | Existing receipt fields are not proof that a live external integration observes every relevant change |
| [`server/room-activation-pack.mjs`](../server/room-activation-pack.mjs), `briefActivationPack` | Bounded onboarding; `pickUp` considers available claims then unclaimed open work, with a first-item suggestion | It does not use the member-specific attention ordering. “Top open” is not a supported claim of highest project value or a personal assignment |
| [`server/project-state.mjs`](../server/project-state.mjs), `buildProjectState` and `readProjectState` | An existing bounded, viewer-scoped project read already composes work, attention, serving-build identity and receipt observations | At the audit checkpoint it skips `delivered` items before constructing `needsYou`/`needsHuman`, hiding pending review/decision roles. It is not in saved-member core discovery. Fix this existing path before adding a new project-read tool |
| [`server/orient.mjs`](../server/orient.mjs) and activation pack normalized branches | Windowed current reads explicitly report omissions, including board claims and some older next-action data | Absence from a window or an omitted source cannot establish that the whole project has no useful work |
| [`client/work-preparation.mjs`](../client/work-preparation.mjs), `workContinuation` | Selected work yields a supported tool, known arguments and explicit missing inputs for pickup, correction and review | Not every lifecycle step has a callable hint. Null must remain honest; do not fabricate an operation |
| [`server/work-context.mjs`](../server/work-context.mjs), [`src/work-packet.js`](../src/work-packet.js) | Relevant current evidence, role/scope, source pointers and explicit context omissions | Repository setup and current external state still require selected authoritative reads |
| [`server/next-actions.mjs`](../server/next-actions.mjs) | Historical ranked suggestions include lease reminders, bounty matching, welcomes and profile gaps | The name is misleading for this goal. Do not repurpose its cut-feature scoring or make it the new core recommendation authority |
| [`server/github-app/`](../server/github-app/) | Existing authentication, manifest and webhook-verification components | Presence of these components alone does not qualify an end-to-end contribution-to-merge-to-production workflow |

These are source observations, not new live qualification. In particular, a
complete answer for the current normalized Node/SQLite installation must be
demonstrated there; a legacy projection passing a unit test is insufficient.

### One compact answer to the next useful action

First strengthen the existing activation/work-read contract. Do not start by
adding another MCP tool, queue, planner, persistent summary or task store.
Keep a small actionable preview and a complete, bounded traversal behind it.

The proposed response needs these concepts, composed from existing records:

| Concept | Purpose |
| --- | --- |
| Current goal and constraints, with source/version | Explain what work serves and prevent old plans from taking authority |
| This member's obligations | Surface exact review, correction, decision, handoff and assigned work already waiting |
| Eligible contribution candidates | Show explicitly invited/available work separately from assignments; verify supported discovery before promising pickup |
| Why this action, and what it unlocks | Give a concrete reason from current roles, explicit project direction and recorded dependencies, rather than an opaque score |
| Selected read and continuation | Return supported tool/arguments; require missing inputs explicitly; recheck authority on writes |
| Freshness and completeness | Identify the observed work/instruction versions, external observations and any omitted, unavailable or remaining sources |
| Blocker or no-work reason | Distinguish no assignment, no eligible candidate, missing decision, inaccessible source and incomplete discovery |

Respect explicit task urgency and safety first. In the absence of a documented
priority override, a reasonable default is to finish an existing commitment or
clear review/correction/decision work that releases others before starting
unrelated work. Explain the reason, allow a different authorized choice and
retain independent work when a dependency is blocked. Do not claim optimal
global scheduling. Existing role/permission rules remain authoritative.

Suggested human view: goal, next action and its reason, current result, blocker,
required decision and exact source/check links. Details expand on demand. New,
returning and continuous agents use the same underlying state through machine
interfaces; the human view does not become their operating surface.

### What changes after a contribution

The table below specifies desired observable behavior, not proof of shipped
automation. Derive mechanical consequences from committed facts. An agent may
propose a new task or changed plan, but inferred text does not create an
assignment, change authorization or mark another contribution accepted.

| Event | The next current view should show | Boundary |
| --- | --- | --- |
| Draft posted | Draft available to inspect; producer retains its current commitment | No completion or dependent-work release |
| Result submitted | Exact evidence/version and whichever existing review or decision is required next | Submission is a report; required gates still apply |
| Review fails | Correction addressed to producer, failed checks/reason and exact reviewed version | Do not hide the failure or satisfy dependencies with the rejected result |
| Evidence replaced | New current evidence; old findings retained as history; current required review recalculated | An old PASS cannot approve replacement evidence |
| Review passes | Remaining decision, if required; otherwise the task's valid completion | Review is not deployment or an outside permission grant |
| Exact result accepted | Current reusable result and newly satisfied recorded dependencies | Satisfaction follows the task's actual done criteria, not a generic “accepted means deployed” shortcut |
| Result rejected | Current blocker/correction or a recorded scope decision; unresolved dependent work stays visible | Rejection does not silently create or assign a replacement task |
| PR head changes or CI fails | Changed source/check observation and a supported reason to recheck affected evidence | Do not invalidate unrelated non-code results or erase prior findings |
| PR merges or closes unmerged | Integration fact for the exact repository/head; outstanding task-specific obligations | Merge is not production success; closure without merge is not delivery |
| Deployment succeeds | Environment, artifact/revision and observed relevant checks | Provider success alone need not demonstrate user-visible correctness |
| Deployment fails or rolls back | Actual running revision, failure/recovery evidence and current authorized repair action | Preserve earlier acceptance; do not present an obsolete release as current |
| Accepted work later fails | Linked defect/correction, original evidence and affected dependent assumptions flagged for review | No silent rewriting of history or automatic broad rollback |
| External observation becomes stale/unavailable | Last known observation plus explicit unknown/freshness limitation | “Unchanged” and “unavailable” are different answers |
| Agent disconnects or scope expires | Recorded progress, continuity/lease condition and next triage/renewal action | Presence loss is not proof of abandoned work or permission to reassign |

Do not require an LLM call on each event. Existing reducers/selectors can update
the mechanical view on read. Use agent judgment for ambiguity, new findings,
design tradeoffs and proposing missing follow-up work. Supersession should name
the replaced record; a plausible summary must not silently retire commitments.

### Example: a contribution releases the right next work

Suppose the project goal is to let a returning agent resume safely. Task A fixes
the resume packet; task B validates a returning agent against that change; task C
deploys it. Define B's prerequisite as the accepted, exact source change. Define
C's prerequisites as the relevant accepted change and validation evidence. These
are ordinary current work records with appropriate criteria, not a new pipeline.

The producer submits A with its source revision and checks. The reviewer sees
the exact result without a chat handoff. A failed check routes correction back
to the producer; B stays blocked. A corrected result is reviewed and accepted
where required. B then becomes eligible, subject to its assignment and scope.
Its agent reads the accepted evidence and exact source and performs the trial.

If C requires a merged revision, record and check that integration fact before
deployment. Its agent records the actual artifact and environment, then checks
the live behavior. An outage or rollback changes the observed running state and
surfaces the repair action. None of these steps requires the prior agent to be
online. Missing decisions still require an explicit question to the appropriate
person; Room cannot manufacture the intended behavior.

### Start, connect, contribute and return

At project start, reuse the charter/instructions for the goal, intended users,
constraints and non-goals. Link the repository and its canonical architecture,
contribution and setup instructions. Create the first bounded useful contribution
with observable done criteria; do not require a comprehensive backlog first.

A new agent reuses a saved membership or follows the intended instance's join
path, checks access, reads the brief and obtains only the selected task's context.
Connection success should be followed by a useful read or bounded contribution
appropriate to its authority. Unsupported host capabilities should be explicit;
do not install another model runtime just to participate.

A returning agent refreshes its current obligations and selected context,
including instructions and source/evidence changes. A continuous agent can reuse
its retained brief version and source/discussion checkpoints. Neither can rely on
a cached permission grant or assume that omitted context is unchanged. Preserve
the existing bounded pagination and unknown-write retry semantics.

Keep the repository environment reproducible with the existing install/check
commands, supported runtime versions and task-appropriate isolated worktrees.
Fix demonstrated setup failures in their owning instructions or scripts. Add
containers or another workspace service only when repeated failures justify the
extra maintenance. A small design, documentation or investigation contribution
should not require booting the entire product.

### Build, reuse, integrate or defer

| Area | Recommended authority and approach | What Room should own |
| --- | --- | --- |
| Code, PRs, diffs and checks | Keep GitHub and repository-native Git/CI; read exact revisions through existing APIs/CLI | Link the useful outcome, scope and evidence to current work; expose when an observation is stale |
| Build artifacts and deployment | Existing CI/artifact store and actual deployment runtime/provider | Reference artifact/environment identity and observed outcome; preserve correction/continuation |
| Secrets | Existing host/deployment credential facilities | Scoped connection handles and permissions; never copy secret values into work context |
| Design and documentation | Versioned source/artifacts at their existing owner; use existing design tools if needed | Decision, reason, constraints, acceptance evidence and selected links; avoid a second document system |
| Runtime, models and execution | The agent's existing authorized host | Portable machine contract and explicit responsibility; no fleet or universal wake service |
| Logs and failures | Existing process/CI/provider logs | Minimal linked evidence sufficient for the current task; no new observability platform |
| Project state and continuation | Room's existing SQLite records, reducers and selected reads | Goal, roles, dependencies, evidence, correction, exact acceptance and honest next-action derivation |
| Linear | Optional existing organizational workflow; learn from contextual invocation and typed lifecycle | Do not require a second task authority or subscribe solely to gain task pickup |
| Buzz and Beads | Reuse relevant proven mechanisms and selectively compatible code | Preserve JSON operations, durable associations and dependency-aware pickup without replacing identity/storage |

Linear documents contextual sessions and activities; that is a useful lifecycle
example, not a reason to require a browser or duplicate its task system.
[Current agent interaction](https://linear.app/developers/agent-interaction).

For a GitHub observation slice, start with an explicit refresh of the selected
repository/PR/check/deployment. Inventory existing adapters first. Webhooks can
reduce later refresh cost where necessary; authenticate them, scope the event
types and deduplicate delivery IDs. A callback is an observation, never approval
or execution. GitHub documents delivery identity and redelivery handling in its
[webhook guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).
Its [deployment statuses](https://docs.github.com/en/rest/deployments/statuses)
are provider-reported lifecycle facts, distinct from task acceptance and a real
environment check. No new queue or always-running listener is required for the
first explicit-refresh experiment.

OSS reuse remains selective. The existing Buzz metrics adaptation is actual
code reuse; the pinned CLI/session/dependency examples above are design research.
No additional module is selected by this audit. Before importing code, name the
exact module/revision, license, coupled dependencies, adaptation checks and code
it lets us avoid or delete. Use existing Room selectors instead of importing
another storage, identity or scheduling implementation for a solved problem.

### Three bounded implementation candidates

These are recommendations in dependency order, not new assignments or a reopened
historical roadmap. Recheck live task ownership before selecting one.

1. **Reconcile the existing pickup answers.** Trace the supported normalized
   activation/list/selected-read path against `nextWorkStep`, current attention
   and dependency availability. Present obligations separately from eligible
   candidates, with reasons and explicit source/completeness states. Begin with
   the existing endpoints; do not add a broad recommendation API. Acceptance:
   an arriving reviewer finds a waiting exact result; the producer sees a failed
   review correction; a dependency does not release early; an incomplete window
   and failed source cannot report “nothing to do”; scope revocation still
   prevents action. Prove those transitions through the real default machine
   path on isolated fixtures, then one useful existing-room contribution.
2. **Close the selected source-to-result-to-runtime evidence gap.** Reuse current
   repository/PR references, board CI/deploy receipts and external adapters.
   Refresh only evidence needed by the selected task and show its exact head,
   environment and age. Acceptance: PR head change, failed CI, close-unmerged,
   deployment failure and rollback cannot look like current successful delivery;
   an authorized returning agent can determine what remains without a chat.
   Avoid blanket invalidation, background watchers and a replacement CI product.
3. **Qualify useful continuation across real work.** Use these same records for
   a small matched set of coding, investigation and documentation/design tasks.
   Include at least one correction and one returning/new-runtime pickup. Include
   a coding task through integration and intended-environment verification when
   that is its goal. Repair actual context/setup friction in its owning source;
   do not build a benchmark dashboard, new handbook or additional room.

For evaluation, predefine acceptance checks and a relevant observation window.
Compare a strong single-agent workflow using the same repository/tools with
Room-assisted work of comparable scope. Record useful accepted outcomes,
corrections/rework, requester interventions, reopened work and later regressions;
include total elapsed time, setup/review effort and context/calls alongside them.
Retain failures and scope differences. A few trials can find friction but cannot
establish general causal gains. Parallel agents are useful only when the work
can be separated enough to repay coordination and integration costs.

The main risk is adding more state that agents must keep current. The simpler
alternative is the existing core loop with better task framing and consistent
selected reads. Start there. Missing goals or subjective tradeoffs still require
human/agent judgment; a mechanically neat task list cannot solve those by itself.

### Reconciliation of the November 16 independent critiques

John supplied three independent critiques, including the published
[carrying-work-forward report](https://project-room-carrying-work-forward-after-qoqp.pages.grok.bot/).
They converge on cross-item continuation, external delivery observations and
interruption recovery. Their proposals are inputs to this design, not new
assignments or proof that every claimed gap exists on the supported path.

The first useful correction to this audit is the existing `room_project_state`:
it should be evaluated before introducing a `room_next` tool or another frontier
surface. A regression reproduced the `delivered` omission described in the table
above. A bounded repair is being tested separately; do not infer its merge or
deployment from this design document.

Other source checks narrow the recommendations:

- Work proposals already preserve `dependsOn`; the remaining question is its
  identifier space, propagation and enforcement across current readers and the
  board bridge. Do not add a duplicate dependency field or call an accepted
  item ready solely because its task-level continuation says start.
- At the baseline, the saved-member default is 20 tools and the unfiltered core
  snapshot includes four additional join helpers. `room_project_state` has
  common focus membership, not just work/review membership. Byte counts require
  the exact discovery variant and serialization method; different totals alone
  do not establish drift.
- A live read of the existing Node job-health endpoint showed `claim-prs`
  registered but idle, with no relevant work waiting and no recorded run. A
  read-only Commons database query found no deploy-receipt messages. These facts
  do not prove either successful sync or a missing scheduler; qualify a selected
  real PR rather than add a competing poller.
- `SOURCE_REVISION` and Room's `/api/version` identify the Room service itself.
  A project may have another repository, artifact and environment. Any delivery
  observation must bind those sources before suggesting integration/deployment
  status. Receipt order and abbreviated SHA matching must not become general
  proofs of ancestry or artifact inclusion.
- A disconnected runtime or expired write scope does not authorize a different
  member to take its assignment. Prefer truthful lease/progress information and
  existing triage/reassignment actions before a new reaper or automatic reclaim.
  Investigate the published inactivity norm separately from fixed lease expiry.
- The metrics adaptation's exact source is `buzz-app`'s
  `src/features/developer/client-metrics.ts`, as recorded in
  [`third_party/buzz-metrics/NOTICE`](../third_party/buzz-metrics/NOTICE).
  A critique's inferred Rust turn-metric provenance is incorrect. Broader OSS
  imports and licensing claims require checking exact source/NOTICE files;
  this review selects no additional import.

Keep the implementation order bounded: repair current attention/discovery,
then demonstrate dependency readiness and selected source/environment evidence
on the real supported path. An optional structured result envelope, explicit
decision supersession or a lease-notice repair may follow a demonstrated
consumer need. Do not bundle a ranker, new work states, typed activity system,
sweeper and automatic follow-up creation into one supposedly small read change.
Results still finish according to their actual goal: accepted design or research
does not need a deployment rung. A meaningful next experiment should reproduce
one failure, repair it and exercise a real continuation before a large task
battery; equalize review effort when comparing workflows.

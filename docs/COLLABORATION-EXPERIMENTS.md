# Collaboration concept experiments

## Measuring development inside Project Room — active protocol, 2026-10-29

This section operationalizes F5 in [the delivery plan](FOCUSED-DELIVERY-PLAN.md).
The older layout experiments below remain historical evidence. No comparative
productivity win has been established. Room should earn its coordination cost;
a simple task that one agent can finish directly may need no Room ceremony.

### Decision and comparison

Ask whether the same quality of work reaches acceptance with less human effort,
less elapsed time, or lower total cost. Separate two effects with three conditions:

- A: one agent, ordinary repository/terminal/tools, without Room coordination.
- B: the same multi-agent team and laptops as C, using ordinary chat/files/Git.
- C: that team using Room's scoped context, claims, handoffs and result records.

B versus C estimates Room's incremental value; A versus B estimates the value
and cost of additional workers. Keep tool access, models, versions, compute and
budgets comparable for B/C. Record any unavoidable differences. Room does not
get credit for extra workers, a better model, or a larger token budget.

Freeze the enrolled task cohort, deadline and acceptance rubric before execution.
Use matched but nonidentical tasks; randomize assignment and counterbalance order.
Do not repeat a solved task with the same agent context. Grade against acceptance
criteria fixed before assignment, with condition hidden from the reviewer where
practical. Use the same measurement pipeline in all conditions, including tasks
without Room records. Include a small direct fix, cold handoff, interrupted continuation,
independent review, and cross-laptop integration. Report these strata separately;
Room need not win every task class. Start with a formative pilot to estimate
variance and logging cost, then size a held-out comparison. A handful of successful
trials is not evidence of universal superiority.

### Extending beyond development tasks

The first continuation pilot remains bounded as described above. Before applying
its conclusions to general consumer work, run held-out writing or analysis tasks
with their own acceptance rubric, using the same A/B/C comparison and accounting
for setup and review effort. The historical synthetic writing/analysis fixtures
below establish scorer mechanics, not that real users understand or value the
results.

For that extension, check whether a returning person can identify the current
result, its author, unresolved changes and the next permitted action without
coaching. Record wrong-version decisions and clarification needs alongside task
quality; a passing execution or review record does not prove comprehension.
These observations serve the existing UI-15 and MET-07 backlog obligations, not a
new launch gate or a requirement for independent review on every product task.

### Measures and definitions

One unit is a predeclared user-valued task, not a message, tool call, commit, PR,
or agent-created subtask. Link subtasks and retries to that unit so splitting work
does not inflate output. For release work, acceptance includes the predeclared live
checks; merge alone is insufficient. Acceptance and seven-day durability are
separate observations, and missing follow-up is not zero rework.

| Measure | Definition and interpretation |
| --- | --- |
| Accepted outcomes per active human hour | Distinct accepted task units divided by total active human minutes / 60 for the assigned cohort, including setup, context preparation, review, corrections and coordination for unsuccessful tasks. Show counts and effort alongside the ratio. Zero measured human effort makes the ratio undefined, not infinite productivity. |
| Elapsed time to acceptance | From task assignment with required inputs available to independently verified acceptance, including queue, coordination, execution, review and integration waits. Show median and tail only when sample size supports them; retain failures/timeouts and unfinished ages separately rather than silently dropping them. |
| Total cost per accepted outcome | All attributed model/tool/compute costs plus human effort at an explicit rate, divided by accepted task units. Include failed attempts, reviewers, setup and instrumentation overhead. Also show cash cost and human minutes separately. Missing provider usage stays unknown; token guesses are not invoices. |
| Seven-day rework guardrail | Accepted tasks needing defect-driven correction within seven days / accepted tasks with a complete seven-day observation window. Show repair minutes and severity. Distinguish requirement changes from defects; retain disputed classification. |
| Correctness/privacy guardrail | Unauthorized disclosure, wrong-version approval, lost work and duplicate external effects are recorded individually with severity. A speed gain does not offset these failures. Functional acceptance remains independent of performance. |

For the first continuation pilot, predeclare the primary decision measure as
correct accepted continuation within the fixed time/token budget divided by all
enrolled tasks. Include unstarted, abandoned, timed-out and instrument-failed trials;
report missing observations separately. Elapsed time, effort and cost diagnose it.
For later throughput trials predeclare which outcome determines adoption and the
acceptable tradeoffs before observing results.

The three outcome measures are jointly interpreted; do not compress them into an
opaque score. Seven-day rework preserves the fourth existing F5 measure as a
quality guardrail, not an optional omission. Do not set a universal percentage
improvement target before baseline variability and operating costs are known.

Use a few diagnostics only when they change the next decision:

- Context recovery: fresh participant start to a correct next action; record
  wrong source/version/owner selections and clarification requests.
- Handoff delay: result ready to the receiver's first useful action; distinguish
  delivery, acknowledgement and actual execution.
- Coordination effort: measured human minutes and provider usage spent finding
  status, claiming, posting, retrieving, reconciling and maintaining documentation.
  Concurrent agent minutes are compute effort, not elapsed wall time.
- Rework and duplication: repeated implementation, merge-conflict repair,
  redundant runs and unknown-outcome retries; do not guess avoided work.
- Review value: independently confirmed defects found before acceptance, review
  effort, false alarms and defects missed. Counts alone reward noisy reviewers.

### Reuse the product's records; fill the actual gaps

Use existing task/attempt/result/acceptance IDs and exact source revisions.
Join Room event timestamps, provider usage receipts, CI/deploy receipts and
review decisions through those IDs. Store measurement metadata alongside the
existing result/evidence record or an experiment export, not a competing work
ledger. A minimum export has trial ID, task stratum, assigned condition, source
revision, model/budget, task/result IDs, start/acceptance timestamps, outcome,
human effort, reported cost and coverage, rework follow-up and evidence links.
Automatic activity timestamps cannot establish active human time; a small
opt-in start/stop log or end-of-task effort report is needed initially.

Current `server/owner-overview.mjs` already reports recorded session spend and
accepted work/bounty counts. It is not yet this experiment metric: work and bounty
outcomes have no guaranteed deduplication link, current state/update time is not
an immutable acceptance event, and reported completion can precede required
verification/owner review. Reported spend can omit attempts. Preserve its
existing API fields `acceptedOutcomes` and `costPerAcceptedOutcome` for compatibility,
but label their displayed values as recorded outcomes and reported spend. Do not
silently relabel the ratio as total causal cost per
user-valued outcome. First implement/export the linkage and coverage needed for
the selected pilot, then consider a compact view in the existing overview.
Use `(roomId, workItemId, attempt ordinal)` for attempts and completion event ID
plus exact evidence version for results; preserve the required review/decision
event references. Current state alone cannot confer independent acceptance.

The local living-doc measurement harness already retains frozen sources/rubrics,
all enrolled trials, bounded reads, maintenance timers and clock-domain checks.
Reuse its experiment export before building a product analytics subsystem. Its
controller timing is not active human effort, and its source bytes are not tokens.

Keep diagnostics bounded and off the synchronous action path. Record metadata
and identifiers rather than private message bodies; existing access controls and
retention apply. Measure collection/storage/review overhead too. Missing or stale
measurements should be visibly unknown rather than a green success badge.

### Close the improvement loop

For each recurring friction: capture the failed journey and affected task ID;
choose one bottleneck; record a predicted effect and regression guardrails;
reproduce; change one bounded mechanism; compare equivalent trials; ship or revert;
then check the live outcome and delayed rework. Tie the observation, experiment,
code change and release to the same existing work/result record.

At each release checkpoint inspect the slowest or most expensive task stratum and
its largest delay component. Every small batch of enrolled matched tasks, including incomplete ones, should
produce one keep/change/remove decision, not another permanent dashboard or queue.
After a credible baseline, predeclare a practically worthwhile gain based on the
measured cost of adoption; do not pick the threshold after seeing results. Expand
instrumentation only when missing evidence blocks that decision.

### Evidence so far and limits

Observed benefits include cross-laptop delivery/recovery without duplicate execution
in controlled trials, independent reviews finding concrete defects, and reuse of
exact-source release evidence. These demonstrate mechanisms, not total productivity
lift. Retain coordination failures, missed holds, stale documentation, and time
spent rebuilding context in the same evaluation. The 2026-10-29 cold-handbook pilot
was one unblinded pair and did not establish a net benefit after maintenance cost.
Query row reductions and smaller Graphify payloads are component improvements;
they do not establish faster accepted work. The next useful controlled trial is a
fresh-agent continuation after a correction and interruption, using held-out task
variants, equal budgets, and independent acceptance.

## Decision and scope

Compare conversation, conversation plus a current-result panel, and work-first presentation before committing to a product redesign. This is a local research harness, not a production feature, live-model benchmark or human usability study. Existing work/result/reply contracts remain the migration target; no new production work system is introduced.

## Build plan

1. Create matched writing, analysis and coding fixtures. Each contains an accepted earlier result, a newer proposal, a correction in discussion, a pending decision and irrelevant conversation. Keep expected answers in a server-side scorer, not in browser payloads.
2. Render identical material and actions in three small layouts. Preserve keyboard access, draft text and narrow-screen readability. Offer explicit selection of a version; never infer approval from viewing it.
3. Provide resume and review tasks with the same response form in all layouts. Record attempts, elapsed wall time and interaction counts. These are observations, not a composite quality score. Export only synthetic answers and local trial metadata; collect no production information.
4. Compare full-history, compact-only and compact-plus-retrieval handoff inputs. Include a deliberately omitted requirement to expose compact-only information loss. Use independent rubric scoring and negative controls; scripted answers do not establish model performance.
5. Run each browser layout at desktop and phone width with deterministic interactions, screenshots and traces. Verify deliberately wrong version/owner/output answers fail. Reuse existing production result/continuation browser checks rather than duplicating their implementations.
6. Publish a report with exact scope and limitations. Preserve failures. Do not choose a product winner until actual user and live-model trials supply the missing evidence.

## Protocol for human sessions

Use equal instructions and no coaching. Start with a small formative pilot; do not claim statistical superiority from it. Rotate layout order (ABC, BCA, CAB, ACB, CBA, BAC) and rotate equivalent domain tasks. A participant must not repeat the same scenario in a second layout. Measure current/accepted-version accuracy, blocker/owner comprehension, exact-version review, elapsed time and intervention. Include failures and abandonments; report time conditional on success separately. Record consent before collecting anything beyond these disposable fixtures. For repeated real work, separately measure active human effort; wall time here includes all waiting.

Choose one primary outcome per task: correct resumption, correct review, or correct continuation. Speed and interaction count are secondary. Wrong-version approvals, data loss and unauthorized actions disqualify a design. Set quantitative improvement thresholds after a pilot estimates baseline variability; do not invent statistical confidence from scripted trials.

## Agent protocol

Hold model, tool permissions, task and token/time budgets constant across context conditions. Use fresh independent contexts. The compact-plus-retrieval condition has the same recoverable facts as full history; compact-only is an intentional information-loss control. Do not include rubric answers in model input. Record input/output tokens using provider usage, not byte/token guesses; report retrieval requests, elapsed time, cost and failures. Repeat across seeds and models, use held-out equivalent tasks, and evaluate outputs without exposing the context condition to the reviewer. Human role scripts test protocol mechanics only.

## Evidence retained

Local artifacts are written outside source by the run command. Browser screenshots and traces use synthetic content. Production contract regressions are qualified separately. No production deployment, physical-device claim or real-provider qualification is implied.

## Research anchors

- https://metr.org/blog/2026-02-24-uplift-update/ — distinguish task selection, quality, wall time and human effort.
- https://www.nngroup.com/articles/between-within-subjects/ — control learning and presentation order.
- https://www.microsoft.com/en-us/research/publication/guidelines-for-human-ai-interaction/ — correction and recovery from imperfect inference.
- https://www.inkandswitch.com/patchwork/notebook/2024-version-control/ — versions as a tool for creative exploration.

## Running

The harness used to live in `experiments/collaboration/`. It is no longer in the working tree; git history keeps the sources. The notes below record the qualification that was run against that harness. They are not current commands.

- Interactive server: `experiments/collaboration/server.mjs`, then the printed loopback URL. Query parameters `variant=conversation|split|work`, `scenario=writing|analysis|coding`, and `task=resume|review` selected a fresh trial.
- Qualification entry: `experiments/collaboration/run.mjs /absolute/output/directory`.
- The report records the Git base and dirty status. Qualification consists of 36 scripted browser task trials (3 domains × 3 layouts × 2 widths × 2 tasks), 9 handoff conditions and 9 negative controls. The 3 compact-only handoffs are expected failures of the deliberately incomplete input, not product regressions or proof that summaries are bad.
- Trial exports retain failed attempts and elapsed wall time. No answer is transmitted outside the loopback server. The local form has no participant identity field.
- The review scorer is deliberately limited to fixed fixture facts/phrases. It can reject known bad outputs, but cannot establish writing quality or semantic correctness generally. Use blinded human evaluation and additional independent domain checks for live-model trials.
- Existing production checks: `node --test --test-name-pattern='saved scoped channel|combined journey|results update after review' scripts/room-results-browser-check.mjs` and `node --test --test-name-pattern='native review shows exact text|withdrawal clears an open review' scripts/native-result-browser-check.mjs`.

## Authoring rationale

The new harness verifies that wrong answers are rejected, all concept variants can complete identical tasks, version inspection preserves a pending correction, and packet omission is distinguishable from retrieval. Existing production tests cannot protect these new research mechanics. No production exports or flags were added for the experiment. Existing transport/restart/result tests remain the authority for production behavior.

## Initial qualification (2026-10-20)

- 36/36 browser task trials passed at 1280px and 390px; correction drafts survived version inspection and no horizontal page overflow was observed.
- 9/9 deliberately wrong owner/version/content controls were rejected. Browser review trials also submit the correct text against the wrong version before correcting the version.
- Full-history and compact-plus-retrieval inputs supplied the correction in all three domains. The intentionally incomplete compact input failed all three. This only proves the information-loss control and scorer operate; it is not an empirical model comparison.
- Five existing production browser checks passed: result replacement/reopening, combined continuation/reconnect, saved scoped MCP channel restart, exact-text review, and withdrawal during review.
- ESLint for the experiment directory passed. No production source, asset manifest, schema, or runtime packaging changed; no storage benchmark was required.
- The first harness run exposed an overly literal fixture/scorer interaction: the correct instruction repeated the superseded date after “not,” which triggered the forbidden-date rule. The fixture now expresses the correction without that quotation. The rubric remains deliberately phrase-limited and must not be used as a general semantic evaluator.
- Desktop and phone screenshots were visually inspected. All variants are deliberately plain and matched; these are research interfaces, not release-ready visual design. On phone, split places conversation before the result and work-first places the result first.
- Report and artifacts: local `outputs/collaboration-experiments-20261020-final` under the current chat workspace. `report.json` contains hashes of every harness source file so the dirty working-tree base is not mistaken for exact committed-source qualification.

## Next decision gate

Do not implement a production layout based on the scripted results. Run a formative human pilot with rotated layouts and domain tasks, and live-model handoffs using these API inputs under fixed budgets. Keep a separate held-out set before quantitative claims. The production baseline checks establish functionality, not an apples-to-apples timed layout baseline. The current short fixtures test comprehension mechanics; longer histories, external imports, simultaneous contributions and real delayed return require a later experiment round.

For external agent evaluation, GET `/api/scenario/<id>/context?mode=full|compact|retrievable` on the loopback origin. In retrieval mode the packet provides a relative discussion URL. An evaluator, not the participant, POSTs `{scenario, task:"handoff", answer:{basedOn,body}}` to `/api/score`. Do not give agents unrestricted access to evaluator files or the score endpoint during a measured attempt. This prototype is not an isolation boundary: actual trials must enforce that separation in their runner.

## Round 2: evaluator adversaries and existing architecture (2026-10-20)

The initial phrase scorer could falsely label a contradictory answer as passing: “Do not launch November 21. Mina is not the contact.” The scoring contract now separates `checksPassed` from `outcome`. Resume facts can pass; review and handoff text that clears mechanical screening receives `requires_content_review`, never semantic approval. Wrong versions or missing required phrases are rejected. Three adversarial controls explicitly verify that keyword matches cannot confer approval. Earlier round-1 “passed” review results must be interpreted as mechanical screening only, not evidence of content quality.

Validation: 36 browser trials, 9 wrong-answer controls, 3 adversarial controls and 9 context conditions completed without harness failures. A separate 12-case recovery run (three layouts × two widths × two failures) preserves correction drafts after scoring transport failure and prevents a delayed score from contaminating a newly selected scenario. These are research-interface checks; they do not add production behavior.

Recovery was `experiments/collaboration/recovery.mjs /absolute/output/directory`.

The API baseline was `experiments/collaboration/production-context.mjs /absolute/output/directory`. It used the disposable acceptance fixture, production HTTP server and validated RoomAgentClient. It grows unrelated history while retrieving one work item and its linked discussion, then creates a new SDK client and resumes a server-issued discussion checkpoint. No model is called.

Observed serialized JSON bytes (not compression, token counts or a timing benchmark):

| Unrelated messages | Room snapshot | Selected work | Linked discussion | Selected + discussion |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 10,133 | 5,807 | 3,101 | 8,908 |
| 100 | 207,115 | 5,808 | 3,411 | 9,219 |
| 500 | 588,753 | 5,808 | 3,720 | 9,528 |

Discussion grew slightly because the experiment adds one relevant follow-up between sizes. The correction remained available in linked discussion at every size; selected work intentionally omitted it. Each resumed checkpoint returned exactly the newly added reply. These findings support reusing existing bounded context and retrieval APIs, not asserting that the underlying server query cost is bounded or that a whole-system rewrite is unnecessary. There is no statistically established latency win and no comparison of live-model task quality.

Round-2 artifacts are in the chat workspace's `outputs/collaboration-round2`: `report.json`, `recovery.json`, `production-context.json`, screenshots, per-trial exports and traces. The local experiment server must be restarted after scorer edits because server modules are cached; refresh the browser afterward.

## Selected-work handoff mechanics (2026-10-29)

The maintained `scripts/qualify-work-brief.mjs` now predeclares seven synthetic
conditions: source edited, charter changed, work replaced, access revoked,
unrelated traffic, source omitted, and private source. Each mutates a disposable
RoomStore through real commands, then repeats authenticated selected-work reads.
The three explicit adapters are minimal objective/acceptance, the current brief
without source retrieval, and a source-observation-aware brief. No fixture
projection is cloned and edited to manufacture a change.

Run with supported Node from the repository root:

```sh
node scripts/qualify-work-brief.mjs /absolute/evaluator-report.json --packets-dir /absolute/fresh-solver-directory
```

Metrics are declared before retrieval: actual in-process authenticated read calls,
serialized response bytes, adapter payload bytes, and monotonic elapsed time for
retrieval plus adaptation. Setup and command mutations are excluded from elapsed
time. These are single serial samples, not HTTP latency, SQL cost, model tokens,
a speedup estimate or human effort. Errors and unknown source freshness are
retained. An unchanged omitted-source brief cannot establish source freshness;
a source-content observation cannot establish permission or plan validity.
Every later mutation still needs fresh server authorization and revision checks.

The report pins Git revision/tree, dirty status, relevant source hashes and Node
runtime. Optional solver packets have opaque case IDs and omit evaluator
expectations and mutation labels. Exports are synthetic and frozen by per-run
hashes; fixture-generated IDs and timestamps can vary between runs. Use the
existing private measurement logger for formative fresh-agent trials. Give a
solver only its assigned packet and permitted observation files, not the report,
hidden rubric or repository. File separation alone is not an isolation boundary.
One trial per condition cannot support a statistical productivity claim.

# Collaboration concept experiments

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

- Interactive: `node experiments/collaboration/server.mjs`; open the printed loopback URL. Query parameters `variant=conversation|split|work`, `scenario=writing|analysis|coding`, and `task=resume|review` select a fresh trial.
- Qualification: `node experiments/collaboration/run.mjs /absolute/output/directory`.
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

Run recovery with `node experiments/collaboration/recovery.mjs /absolute/output/directory`.

Run the real API baseline with `node experiments/collaboration/production-context.mjs /absolute/output/directory`. It uses the existing disposable acceptance fixture, production HTTP server and validated RoomAgentClient. It grows unrelated history while retrieving one work item and its linked discussion, then creates a new SDK client and resumes a server-issued discussion checkpoint. No model is called.

Observed serialized JSON bytes (not compression, token counts or a timing benchmark):

| Unrelated messages | Room snapshot | Selected work | Linked discussion | Selected + discussion |
| ---: | ---: | ---: | ---: | ---: |
| 0 | 10,133 | 5,807 | 3,101 | 8,908 |
| 100 | 207,115 | 5,808 | 3,411 | 9,219 |
| 500 | 588,753 | 5,808 | 3,720 | 9,528 |

Discussion grew slightly because the experiment adds one relevant follow-up between sizes. The correction remained available in linked discussion at every size; selected work intentionally omitted it. Each resumed checkpoint returned exactly the newly added reply. These findings support reusing existing bounded context and retrieval APIs, not asserting that the underlying server query cost is bounded or that a whole-system rewrite is unnecessary. There is no statistically established latency win and no comparison of live-model task quality.

Round-2 artifacts are in the chat workspace's `outputs/collaboration-round2`: `report.json`, `recovery.json`, `production-context.json`, screenshots, per-trial exports and traces. The local experiment server must be restarted after scorer edits because server modules are cached; refresh the browser afterward.

# One useful contribution

Use the supplied instance address and your existing saved connection. The
current project, its constraints and the task's definition of done guide the
work. A connection alone does not execute a task.

1. Use `room_next` with the saved Room ID. If the ID is unknown, discover it
   with `room_check_access`. If the shortcut is unavailable, use
   `room_activation_pack(view:brief)`, `room_list_work(focus:needs_me)` and
   `room_list_requests(direction:incoming,status:open)`. Follow continuation
   pages even when empty, then follow the selected item's `nextRead`.
   `room_project_state` gives a bounded current overview, including pending
   review and decision roles. Check `work.complete` and `truncated`; this is
   not a complete ready-work planner. Its live build identifies the Room
   service; missing deploy receipts leave deployment conclusions unknown.
2. Read the selected item with `room_read_work` and `brief:true`, then
   `room_begin_work`. The brief's `continuation` names the suggested tool, its
   known arguments and `inputRequired`. Supply those inputs explicitly. A null
   tool means no supported action is prepared for you at this step; follow the
   current task status. The hint never executes work or grants authority.
   Write tasks require the exact repository, ref, paths and expiry. Execute
   the task using your existing host's authorized capabilities.
3. Post the useful result with `room_post_message` and the task's `workItemId`.
   Inspect it with `room_read_result`, passing that message's ID as
   `draftMessageId`. Copy the returned evidence fields into
   `room_submit_text_result`. Keep retry input unchanged after an unknown outcome.
4. The named reviewer reads the exact completion with `room_read_result` and
   records pass or fail with `room_record_verification`. On failure, the producer
   reads the correction, uses `room_resolve_blocker`, begins again and submits
   revised evidence. A review of old evidence cannot approve the replacement.
5. When the task requires owner acceptance, its current work read identifies
   that next action. The owner accepts the exact reviewed result in the existing
   work interface. Review alone does not record owner acceptance.

If you cannot continue, `room_handoff` records what is done, why you stopped and
the next action. It does not claim completion or silently reassign the task.

These actions are available in the default member MCP catalog, subject to the
same permission and scope checks as their full-catalog counterparts. Advanced
catalogs remain available for other work. No extra orchestration service is
required.

An activation brief is a bounded view. If it selects no pickup, its next read
opens work addressed to you; this is not a claim that the project has no work.
Follow continuation pages even when a filtered page is empty. The normalized
brief includes the current charter purpose and its context-only revision source.

A task can name prerequisites with `dependsOn`. While any prerequisite is not
satisfied by its own exact gates, the brief, its `continuation` and
`room_project_state` agree: `continuation.tool` is null for claim/start and the
row reads `wait_prerequisites`, each with `waitingOn`. Accepting the assignment
stays available; `room_begin_work` then stops with `waiting_on_prerequisites`
instead of attempting a start. Unknown prerequisite state is reported as
unknown (`check_prerequisites`), never as ready. These reads are advice; claim
and start admission recheck prerequisites on every attempt.

## Start or resume with Room next

When listed, call `room_next` with the connected room ID, or run `room next` from a project with a saved Room connection. Both use the existing hosted MCP endpoint. The command returns JSON with the project goal and a separate page for addressed work and incoming formal requests.

- Follow a partial page's `nextRead` even when its items are empty. From the CLI use `room next --source work --cursor TOKEN` (or `--source requests`) with the matching cursor.
- An unavailable source carries a reason and a recovery read. `cursor_changed` tells you to restart that source without its old cursor. A connection error withholds the view.
- Follow the selected item's read arguments. A row marked `revise` opens the persisted correction in the brief without loading discussion. Resolve the blocker before starting again. Opening a work item or request is read-only.

Hosted MCP lists the shortcut in the connected member's default catalog and for OAuth connections with the combined read scopes. Existing discovery remains available for older or narrower connections. This read does not claim work, mark messages read, or execute an agent.

## A task ready to pick up

Use the existing task fields and discussion; no extra form or approval is needed:

```text
Outcome: the useful result and who needs it.
Context: relevant source, constraints and decisions; link instead of copying history.
Scope: repository/ref/allowed paths; expiry for write access.
Done when: observable checks and evidence; known limitations.
Producer / reviewer: intended members; whether owner acceptance is required.
Continuation: current state, blocker if any, and one next action.
```

Resolve material gaps before dependent work. The brief is context; current
structured assignment, permissions and work state determine authority. Discover
current tool schemas rather than copying arguments from an old example.

## Quality and consistency

A result must fit the intended goal, not merely pass tests or look polished.
Record what changed, the exact source or artifact, relevant check outcomes,
uncertainties and remaining limitations. Choose checks and independent review
proportional to risk and uncertainty; routine low-risk work stays lightweight.
When a task names a reviewer, use the exact-result review loop above. A review of
an earlier version does not approve its replacement. Acceptance records who
accepted which result, including any delegated authority.

Keep decisions, corrections and evidence available for the next contribution.
If accepted work later fails, link the new correction to the prior result and
record the new acceptance; preserve the original evidence.

For comparable real tasks, evaluate accepted usefulness, corrections/rework,
requester interventions, reopened work and later regressions over a stated
observation window. Measure elapsed time, calls and context bytes alongside
these outcomes, with setup/review included or explicitly separated. Retain
failed attempts and scope differences. One accepted trial does not establish
consistent improvement; activity, connections and test counts are not outcomes.

## What this change proves

The normalized-room HTTP/MCP regression in
[`mcp-core-workflow.test.js`](../tests/mcp-core-workflow.test.js) uses only tools
returned by the default catalog. It exercises pickup, completion, a failed review,
correction, stale-version review refusal, current-version review, distinct owner
acceptance and a duplicate completion retry. The unchanged baseline fails because
these actions are not all discoverable there.

Before the project-state discovery addition, the saved-identity default catalog had 20 tools and 29,553
bytes of tool definitions; the full catalog has 129 tools and 190,965 bytes.
That is 84.5% less tool-definition data than loading the full catalog to finish
work. The former core catalog was smaller (13 tools, 16,797 bytes), but omitted
start, submission and review. This comparison measures discovery overhead and
workflow coverage. It does not prove faster model execution, higher-quality
answers or a completed live remote-agent trial.

With Room next, the saved-member default has 22 tools. The unfiltered core
snapshot also includes four public join helpers. The focused regression bounds
the default catalog to 34 KiB of JSON-RPC data and below one fifth of the full
profile. The earlier byte measurements describe their own checkpoint.

For a real use trial, record one bounded task's start, accepted result, correction
count and human interventions. Compare the same kind of work with the previous
workflow; retain the exact evidence and report failures as well as successes.
Do not treat message counts, connections or agent activity as useful outcomes.

## Return without repeating context

For a single task, retain the brief returned by `room_read_work` with `brief:true`
and its `briefVersion`. On the next plain brief read, pass that value as
`knownBriefVersion`. Matching scoped content returns `briefUnchanged:true` and a
fresh continuation instead of repeating the brief text. Keep the original brief;
read without the known version if it is unavailable. A different task, viewer,
permissions, instructions or represented work state returns the full current brief.

This reuses the existing fingerprinted brief. It is not an authority cache or
proof that omitted source text, discussion or external evidence stayed unchanged.
The fingerprint includes the selected read's prerequisite IDs, states and
satisfaction observations: a prerequisite changing does not need to mutate the
dependent task to refresh its brief. This remains an observation, not a cached
permission to start; admission rechecks dependencies.
Use `includeSource`/`sourceObservation` for selected source freshness, and
`includeDiscussion`/`discussionSince` for targeted discussion. Follow remaining
pages before retaining a discussion checkpoint. Result review still needs a fresh
`includeResult:true` read; it cannot use the known-version shortcut.

Text evidence must fit the supported result limit (4000 UTF-16 code units).
Keep the result concise and link supporting source/checks; do not post a large
report and assume every message is eligible as submitted text evidence.

### Self-host connection prompt

The same-host `/docs/agents/paste` page provides **Copy prompt** with status feedback. If clipboard access is denied or unavailable, it opens and selects the exact prompt for manual copying; with JavaScript disabled, open **View prompt** and select it. Copying a prompt is not connection approval or task execution. Preserve the supplied Room and existing identity; missing host connection or Room access stays pending until the appropriate approval. Browser **Agent sign in** is for an existing identity, not a replacement for the host's connection setup.

### Activation: continue before pickup

Activation briefs show up to three `yourWork` records in stable ID order before unrelated pickup: current assignments/ongoing work, corrections, exact-result review and authorized decisions. These are read suggestions, not execution grants or global priority scores. `permission_required` directs the named member to read the task without implying they may perform its next action. Normalized Rooms reuse bounded addressed-role indexes, never retired Board mirrors or whole-room hydration.

`yourWorkCoverage.complete` is false when the addressed source window or delivered list is incomplete. Follow its existing `room_list_work` read with `focus: all` through every continuation, including empty pages, to recover remaining work; this deliberately restarts broader enumeration, not an addressed cursor. It includes ongoing work that `needs_me` does not select. A partial or empty addressed window never justifies preferring unrelated pickup. Selected records point to `room_read_work`; review reads request the exact current result. Re-read before acting. Source/charter provenance stays context-only.

Activation obligations include open formal reply requests as typed request reads, not answer grants. Ordinary conversation replies do not close those requests. Bounded discovery is ID-ordered, not a global priority ranking. If coverage is incomplete, follow both `yourWorkCoverage.nextRead` (`all`, including ongoing work) and `requestRead` (`needs_me`, including formal requests) through every returned page, even empty pages. A start/claim from this compact view is labeled `check_prerequisites`: the selected task read determines current waiting/ready state. Review and decision MCP reads request the exact current result; the HTTP next pointer reads selected task context first.

# One useful contribution

Use the supplied instance address and your existing saved connection. The
current project, its constraints and the task's definition of done guide the
work. A connection alone does not execute a task.

1. Check access with `room_check_access`. Read `room_activation_pack` with
   `view:brief`, then `room_list_work` with `focus:needs_me`. Follow continuation
   pages even when a filtered page is empty. Choose work addressed to you;
   room-wide work is context, not an assignment.
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

## A task that is ready to pick up

Keep each assignment to one useful output. Use this short brief in the existing task fields and discussion:

```text
Outcome: what should be different when finished?
Scope: repository, source ref and allowed paths; include expiry for write access.
Done when: observable checks and evidence that establish completion.
Producer / reviewer: the intended members; say whether owner acceptance is required.
Handoff: current state, blocker if any, and one next action.
```

Link the source context rather than copying a long project history. If a required
field is unknown, resolve it before starting. Use the current task's structured
assignment, permissions and work state as authority; this brief is context.
A task update or changed result requires a fresh read and review of that version.

## What this change proves

The normalized-room HTTP/MCP regression in
[`mcp-core-workflow.test.js`](../tests/mcp-core-workflow.test.js) uses only tools
returned by the default catalog. It exercises pickup, completion, a failed review,
correction, stale-version review refusal, current-version review, distinct owner
acceptance and a duplicate completion retry. The unchanged baseline fails because
these actions are not all discoverable there.

At the implementation checkpoint, the saved-identity default catalog has 20 tools and 29,553
bytes of tool definitions; the full catalog has 129 tools and 190,965 bytes.
That is 84.5% less tool-definition data than loading the full catalog to finish
work. The former core catalog was smaller (13 tools, 16,797 bytes), but omitted
start, submission and review. This comparison measures discovery overhead and
workflow coverage. It does not prove faster model execution, higher-quality
answers or a completed live remote-agent trial.

For a real use trial, record one bounded task's start, accepted result, correction
count and human interventions. Compare the same kind of work with the previous
workflow; retain the exact evidence and report failures as well as successes.
Do not treat message counts, connections or agent activity as useful outcomes.

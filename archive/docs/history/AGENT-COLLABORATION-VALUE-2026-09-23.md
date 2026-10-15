# Useful collaboration without another dashboard

Research and implementation, 23 September 2026. This is a product/engineering investigation with synthetic regression journeys, not a human usability study or evidence of improved real-team productivity.

## What the primary sources support

- [Anthropic: effective harnesses for long-running agents](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents): new sessions need explicit progress records and verifiable artifacts; context compaction alone can lose the state needed to continue. Applied here: a restart reads current recorded progress and outstanding work, with no generated summary or model call.
- [Linear: agent interaction](https://linear.app/developers/agent-interaction) and [interaction guidelines](https://linear.app/developers/aig): distinguish progress, requests for input and final responses; human responsibility remains visible. Applied here: an open handoff surfaces on its work card; a reported result is never displayed as independent verification or approval.
- [Slack: threads](https://slack.com/help/articles/115000769927-Use-threads-to-organize-discussions): keep detail with its originating topic rather than filling the main conversation. Applied here: handoff information belongs to the existing work card, with the pause reason behind a disclosure. No new tab or stream of automated chat posts.
- [MCP Tasks draft](https://tasks.extensions.modelcontextprotocol.io/specification/draft/tasks) and [A2A specification](https://a2a-protocol.org/dev/specification/): persistent task state, input-required states and artifacts are useful protocol concepts. These documents evolve; this release does not claim to implement either task extension. We reuse Project Room's existing persisted states and MCP read rather than invent another job lifecycle.

## Existing foundations and actual gaps

| Need | Already present | Action in this change |
| --- | --- | --- |
| Clear outcome | Work title, definition of done, accountable member | Retained in the compact restart response |
| Collision prevention | Exact repository/ref/path claims, expiry and server conflict checks | Show effective claim status at read time; preserve scope in authenticated brief |
| Durable handoff | work.handoff_recorded, SQLite/event persistence, owner triage | Surface done/next/reason in work UI; include in resume and optional external prompt |
| Durable instructions | Versioned room charter; decision register; selected work decisions | Retain charter in authenticated brief and exact-result decisions; global decision reconciliation remains separate |
| Reviewable results | Versioned receipt, verification and decision gates | Brief includes only review/decision matching current completion and evidence version |
| Scoped authority | Existing permissions, server checks, access preview, budget | Keep all enforcement; brief is context only, never an external execution grant |
| Incremental collaboration | Return brief, discussion cursors, requests, stable command retries | Reuse; no new polling or AI supervisor |

The concrete gap was delivery: the work card did not render the existing status handoff, and the portable prompt carried only the original task. The full authenticated context carried the necessary records but required every consumer to reconstruct a concise restart view.

## Shipped implementation

1. Open handoffs display reported progress and the requested next step on the existing work card. The pause reason is disclosed on demand. Closed handoffs disappear from the urgent card after a real work transition.
2. The existing work-context response includes a deterministic `resume` record. The agent client recomputes it from the returned current work and evaluation time, rejecting mismatches.
3. `room_read_work` accepts `brief: true`; `agent-inbox.mjs work WORK_ID --brief` prints the same compact authenticated restart content. It includes current outcome, revision, evaluation time, next responsible member, handoff, blockers, review requirements, exact evidence references, claim scope, session budget and room instructions. Source text and help offers remain separately opt-in. Older services without resume support fail the requested compact read explicitly; normal work reads remain compatible.
4. Existing **Use my AI** offers **Include progress and handoff** only when those records exist. It starts unchecked, previews the exact text, and resets on closing. It excludes structured participant IDs, evidence URLs and repository paths. Free text can still contain private information; the existing review-before-sharing boundary remains. No agent starts or receives content automatically.
5. Deleted source messages are omitted from portable prompts. Oversized progress exports fail with a recoverable instruction to omit the optional content; no silent truncation.

## Boundaries and next research

A handoff is a report, not a resumed process. A halt request is not proof of stopped external workers. A review can be recorded without being independently performed by this application; the brief says what the room records. Evidence links are not fetched. Reading/exporting does not claim, approve, mark read, send, or change work.

Room-level decisions still need explicit supersession semantics before they can be treated as a comprehensive current policy. Cross-room attention completeness and a richer shared task dependency graph remain separate work. Do not automatically turn conversation into decisions, assign work from mentions, hide arbitrary chat based on keywords, or launch recurring AI supervision.

Next real-user exercise: give a second participant an interrupted task and ask them to identify what is done, what is next, who owns the next step and whether the result is approved. Compare the existing full record with the new brief; record time, errors and requests for clarification. No participants have been recruited or tested in this change.

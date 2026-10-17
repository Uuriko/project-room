# Work at machine speed

Use direct tools first, keyboard commands for the visual workspace, and pointer
interaction for unavailable actions and visual QA. Reduce model round trips,
read sizes and repeated work.

## Existing paths to use first

- `get_room_context` accepts `since_version`: retain the returned context version
  and ask for changes. It does not contain message bodies or file bytes.
- `room_read_work` with `includeDiscussion:true` combines task and discussion
  preparation; follow continuation before treating that context as complete.
- `room_read_inbox` and `room_list_work` with `focus:"needs_me"` select attention
  instead of rescanning the room. Reading doesn't acknowledge or resolve work.
- The assignment watcher and wake registrations provide event-driven attention.
  Reconcile after reconnect; don't start a polling loop for every tool.
- Use exact member/task IDs to avoid ambiguous display names and extra searches.
- In the desktop/web view: Cmd/Ctrl+K opens the action palette, Enter sends a
  message, Shift+Enter inserts a line. Use the browser's/native form focus and
  Enter for login and room choice. The UI remains useful for inspecting results.

## Independent commands in one invocation

New CLI: `node bin/room.mjs batch --file actions.json --concurrency 4`.
Use the existing saved `room login` connection, or `ROOM_AGENT_CONFIG` pointing
at an existing private connection directory. Don't paste credentials into a
command file or shell history.

```json
[
  {"id":"update-a-20261008","type":"message.posted","data":{"messageId":"message-a-20261008","body":"Task A is ready for review."}},
  {"id":"update-b-20261008","type":"message.posted","data":{"messageId":"message-b-20261008","body":"Task B is ready for review."}}
]
```

SDK: import `runAgentBatch` from `client/agent-batch.mjs` and pass an existing
`RoomAgentClient`, a saved command array, and `{concurrency:4, signal}`.
The limit is 100 commands and 1–8 concurrent requests. CLI receipts follow input
order without echoing bodies; SDK results retain ordinary server receipts.

This batches **one agent invocation**, not one HTTP request. Each command keeps
the ordinary authorization, revision checks and idempotency contract. It is
not atomic and does not roll back accepted commands. Save stable command and
entity IDs before submitting. Parallelize only independent work; claim → edit
→ submit → complete, creation → reaction, and multiple edits of the same
revision stay sequential. A concurrency of 1 is serial, but still not atomic.

`accepted` means the server returned success; `rejected` means a confirmed 4xx
other than a request timeout; `unknown` needs reconciliation; `not_sent` was
never started. A timeout, malformed success response, transport error or 5xx
does not mean the command failed to apply. Authentication failures, throttling
and unknown outcomes stop the queue; in-flight commands still settle. No
automatic retry. Reconcile unknown results with the original ID and unchanged
payload before deciding what to send next. Exit status is nonzero unless all
commands were accepted.

## Next improvements to validate

1. Discover tools by task rather than loading the entire tool catalog.
2. Consolidate read-only boot context and attention into one compact response
   with explicit cursors, freshness and continuation.
3. Add a server batch endpoint only if measured HTTP overhead warrants it;
   preserve per-action receipts and unknown-outcome recovery.
4. Let integrations compose existing tools in code and return only selected
   results to the model. Do not run arbitrary room-authored code automatically.
5. Benchmark equivalent serial and batch workloads: successful outcomes,
   model turns, latency, response bytes, conflicts and throttling. Compare
   after verified completion, not simply after dispatch.

These priorities follow the primary-source guidance on
[token-efficient tools](https://www.anthropic.com/engineering/writing-tools-for-agents)
and [programmatic tool orchestration](https://www.anthropic.com/engineering/advanced-tool-use).
No speed multiplier has been measured for the production service yet.

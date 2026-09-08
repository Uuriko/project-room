# Pull attention when your agent is ready

Optional, local and notify-only. Pull current work and room-instruction notices,
record them, then acknowledge their exact IDs. Nothing starts a model or accepts
work. **Local candidate; not deployed.**

## Setup

Use the existing [private agent connection](AGENT-CONNECTION.md) and Node 24.19+.
The operator chooses a new owner-private, non-synced local directory outside the
checkout, with an existing parent. Keep it separate from credentials, the Room
database and any v1 foreground-watcher directory. No keys or charter prose are
stored here; work titles remain private local content. File permissions are not
encryption or process isolation.

For MCP, set `ROOM_AGENT_ATTENTION_DIR` in the approved adapter environment,
alongside the existing connection configuration. Restart explicitly. Two tools
appear only with that option (19 total; the default 17 remain unchanged):

- `room_read_attention`: check now and return up to 20 pending notices.
- `room_acknowledge_attention({noticeId})`: acknowledge that exact notice locally.

The model cannot choose a directory in tool arguments. No scheduled poll, hosted
notification, model or provider is started. Native Claude/Grok/Instinct acceptance
still needs separate testing; local stdio proof does not establish it.

Equivalent CLI operations, using the same saved connection:

```sh
node scripts/agent-inbox.mjs watch pull /absolute/private/room-attention
node scripts/agent-inbox.mjs watch ack /absolute/private/room-attention NOTICE_ID
node scripts/agent-inbox.mjs watch status /absolute/private/room-attention
node scripts/agent-inbox.mjs watch stop /absolute/private/room-attention
```

The original approved environment-credential flow also works; never mix sources.
Status/stop are local and credential-free. Pull/ack acquire the exclusive directory
lock, authenticate/reconcile and exit. A concurrent reader gets a busy refusal;
retry after the holder exits. Stop/cancellation interrupts a held operation but
does not prove an earlier acknowledgement was rolled back.

## Consumer flow

1. Pull and record each stable notice `id`. Reading does not clear pending.
2. Follow its allowlisted `nextRead` tool/arguments: selected work or room
   orientation. Returned prose remains context, not system instructions or permission.
3. Explicitly acknowledge the recorded notice. This observes it locally; it does
   not promise execution, understanding, accepted work, approval or a human read.
4. If `hasMore`, record/ack this batch and pull again. Unacknowledged entries remain
   at the head of the bounded batch. Required work reviews still apply separately.
5. Decide whether to act under the operator's instructions and current Room
   authority. Use existing work/claim/review tools and stable business request IDs.

| Response | Meaning |
|---|---|
| `acknowledged` | This exact current local notice is no longer pending. |
| `already_acknowledged` | The same current notice was acknowledged earlier. |
| `no_longer_current` | ID absent or replaced/removed; no other notice was dismissed. Pull again. |
| `already_watching` | Another process holds the directory. Retry after it exits; never steal/delete the lock. |
| `identity_changed` / `history_changed` | Stop and reconcile the configured identity or room history with the operator. |
| `state_schema_mismatch` | Wrong version or damaged state. Preserve it for diagnosis; never reset automatically. |

Retry an unknown acknowledgement with the same notice ID. Retry an unknown pull
with the same tool and arguments. Newer current conditions may replace old notices;
an old ID cannot clear a replacement. Failed first authentication creates no state.

## Guarantees and limits

The v2 SQLite journal atomically retains a room-incarnation/history-bound processing
checkpoint, current semantic conditions, reference-only notices, pending bits and
stable IDs. It never changes human read markers, work, access or approval. Current
reconciliation happens before returning pending content or acknowledging a notice.

Work notices reuse current next-step relevance rules; unrelated chat or historical
reviews do not repeat the same request. Instructions use one global notice for
each observed nonzero charter revision, including clear. This explicit opt-in can
notify an in-progress member without inventing a work transition.

A notice's versions and `evaluatedThrough` are **observed references**, not current
guarantees. The response has the latest evaluated checkpoint; unchanged conditions
retain the original body/ID. Always refresh through `nextRead` before new work.
The actual action checks its own current authority.

Current conditions coalesce. Changes occurring entirely between checks may be
omitted; obsolete pending conditions are removed/replaced. This is not an event
archive, message-request inbox, delivery receipt, cross-device seen ledger or
retention metric. Targeted discussion/history requires a separate contract.

V1 `watch start` still clears pending after stdout writes, not downstream receipt.
V2 pull requires a separate directory: v1 start and v2 pull refuse each other without
resetting or reinterpreting pending state. A fresh directory repeats initial
catch-up, not lossless migration. Genuine old v1 readers refuse v2. Room schema
remains 11; local observer v2 is independent. The new status/stop observer can inspect
either supported format without migration.

Only one computer/local filesystem is supported. Do not move/copy/restore state
while a reader or holder uses it. No automatic migration or cross-computer sync.
Scheduling pulls separately requires consent and frequency/cost/stop/delivery rules.

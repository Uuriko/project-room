# server/messages-store.mjs

MSG-1/2/3: the `messages` table, double-written with the room event log.
Read paths still use the projection; the command path writes message rows in
the same transaction as the event insert. Events that landed before the table
existed (and events from `importEvents`/`initialize`, which still don't
double-write) are replayed by a budgeted backfill (`runMessagesBackfill`,
driven by the integrity cron). `checkMessagesParity` certifies one caught-up
room per call.

## Public API

| Export | Behavior |
|---|---|
| `MESSAGES_SCHEMA` / `MESSAGES_BACKFILL_CURSOR_SCHEMA` | `messages` table (one row per message per room, PK `(room_id, message_id)`, indexes on seq/channel/thread/DM) and the backfill cursor table. |
| `MESSAGE_ROW_TYPES` | The 7 event types that produce rows: posted/edited/deleted/reaction_set/pinned/unpinned/redacted. |
| `MESSAGES_BACKFILL_BATCH` | 200 events per backfill call (capped at 1000). |
| `messageVisibleTo(row, viewerId)` | DM-addressed rows are visible only to author and addressee (same party rule as `eventsAfter`). |
| `threadRootId(messages, message)` | Walks `replyToId` to the thread root; cycle-safe. |
| `syncMessageRows(db, {roomId, sequence, event, state})` | Upserts one row per message the event touched. `seq` keeps the *earliest* event that wrote the row (edits don't reorder history). Deleted messages store no body; edits store only the current body; `record_json` drops `editHistory`. |
| `runMessagesBackfill(store, {limit, deadline, yieldBetween})` | Budgeted replay of message events into the table, one room at a time, committing cursor + rows every 25 events. A replaced log (`importEvents`) drops the room's rows and restarts. Throws on read-only stores. |
| `checkMessagesParity(store)` | Certifies one caught-up room per call: counts, last seqs, full record equality (`isDeepStrictEqual` on the current record), and stored-body presence. Mismatch clears certification and throws. Holds the writer lock across compare + certify. |

## Invariants

- The projection is the authority during migration; null legacy records wait
  for budgeted replay.
- `seq` on a row is the original posting sequence — never the edit sequence.
- Cursor validity is checked against the event log (`applied_event_id` must
  match); a replaced log resets the room.
- Backfill commits land every `BACKFILL_COMMIT` (25) events with the cursor,
  so a throw or deadline keeps the prefix.

## Top callers

- `server/store.mjs` — imports schema + `syncMessageRows` + `runMessagesBackfill` + parity check; the integrity cron drives the backfill.
- `server/redact-read.mjs` — shares the `storedBody` rule.

## Gotchas

- `syncMessageRows` builds the full id→message map only when a touched
  message is itself a reply (the 3.8k-message room cost ~90ms per write
  otherwise).
- `affectedMessageIds` for `message.posted` with `alsoSendToChannel` produces
  two ids (`{id}` and `{id}:channel`) — the channel copy is a separate row.
- Parity certification is one room per call; the sweep cursor (`SWEEP_ID =
  ""`) tracks progress across calls.

## Stale comments

None found — MSG-1/2/3 tags, the PRIV-1 note, and the backfill/cursor
comments match the code.

# telegram_live_status — durable Telegram live-delivery facts

Reference for the SQLite table `telegram_live_status` (defined in
`server/channel-live-status.mjs`, created on store open in
`server/store.mjs`, "task 10").

## Purpose

The Telegram connection card answers "is Telegram alive?" from two facts:
the last webhook delivery and the last send result. These were kept in
process memory only (class `TelegramLiveStatus` in
`server/channel-adapters/telegram-config.mjs`), so a server restart (or a
Durable Object eviction in production) wiped them. `telegram_live_status`
is the durable replacement behind the same `received()` / `sent()` /
`snapshot()` methods: one row per (account, connection), upserted on write.
Only the latest facts are kept — there is no history.

The table is purely additive: `CREATE TABLE IF NOT EXISTS`, no data
migration, no schema version bump. It is intentionally **outside the
writer fence** (listed in `unfencedAdditiveTables` in
`server/writer-fence.mjs`): older writers have no code path to it, and the
owning class verifies its own schema. It never stores the bot token or the
webhook secret — counters and timestamps only.

## Schema

```sql
CREATE TABLE IF NOT EXISTS telegram_live_status (
  account_id TEXT NOT NULL, connection_id TEXT NOT NULL,
  last_update_received_at INTEGER, received_updates INTEGER NOT NULL DEFAULT 0,
  last_send_at INTEGER, last_send_outcome TEXT, last_send_code TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(account_id, connection_id)
);
```

No secondary indexes (the composite primary key covers the only lookup).
A `connection_id` of `""` (empty string) stands in for null: direct sends
carry no stored connection, so the key coerces null to `""` — still one
row per (account, connection).

| Column | Type | Meaning |
|---|---|---|
| `account_id` | TEXT NOT NULL | Owning account. Part of primary key. |
| `connection_id` | TEXT NOT NULL | Connection id, or `""` for direct (connection-less) sends. Part of primary key. |
| `last_update_received_at` | INTEGER | Millisecond timestamp of the most recent webhook delivery received. Replaced on each write. |
| `received_updates` | INTEGER NOT NULL DEFAULT 0 | Cumulative count of webhook updates received. Accumulates across writes. |
| `last_send_at` | INTEGER | Millisecond timestamp of the most recent send attempt. Replaced on each write. |
| `last_send_outcome` | TEXT | Outcome string of the most recent send, truncated to 32 chars by the writer. Replaced on each write. |
| `last_send_code` | TEXT | Opaque send code (may be null), truncated to 64 chars by the writer. Replaced on each write. |
| `updated_at` | INTEGER NOT NULL | Millisecond timestamp of the last write to the row. |

## Writers

All writes go through `DurableTelegramLiveStatus` (same methods as the
in-memory class, upsert semantics):

- `received(accountId, connectionId, { at, count })` — records a webhook
  delivery: replaces `last_update_received_at`, adds `count` to
  `received_updates`. Callers:
  - `server/http.mjs` — Telegram webhook delivery path (`channelWebhooks.receive(...)` accepted the delivery).
  - `server/channel-adapters/telegram-poller.mjs` — poller records fresh updates received.
- `sent(accountId, connectionId, { at, outcome, code })` — records a send
  result, replacing the previous one (no history kept). Callers:
  - `server/channel-adapters/telegram-transport.mjs` — per-connection channel sends.
  - `server/http.mjs` — direct sends via `/api/inbox` (records `outcome: "sent"`, `code: "direct"`).

## Readers

- `snapshot(accountId, connectionId)` — the card read. Returns the same
  shape as the in-memory `snapshot()`; when no row exists it returns the
  zero-value shape (`{ lastUpdateReceivedAt: null, receivedUpdates: 0, lastSendResult: null }`). Consumers:
  - `telegramLiveView()` in `server/channel-adapters/telegram-config.mjs` — builds the connection card's live facts (used by the connection routes in `server/http.mjs`).
  - `server/http.mjs` — channel send dispatch responses surface the row's `lastSendResult`.
- `verifySchema({ allowAbsent })` — startup/repair-time schema check: the
  stored DDL must match `telegramLiveStatusSchema` (a wholly missing table
  is tolerated with `allowAbsent: true`; anything partially present
  fails). `verify()` — offline integrity check: counters never negative,
  `last_send_outcome` ≤ 32 chars, `last_send_code` ≤ 64 chars.

## Retention

Not specified in code. Rows are never deleted and nothing prunes or
archives them; only the latest fact per (account, connection) is kept
because each write upserts the single row.

## Related files

- `server/channel-live-status.mjs` — schema + `DurableTelegramLiveStatus`.
- `server/channel-adapters/telegram-config.mjs` — in-memory `TelegramLiveStatus` (same method contract) and `telegramLiveView()` (card render).
- `server/store.mjs` — instantiates `store.telegramLiveStatus`, execs the DDL on open.
- `server/writer-fence.mjs` — `unfencedAdditiveTables` entry and rationale.
- `tests/channel-live-status.test.js`, `tests/recovery.test.js` — coverage.

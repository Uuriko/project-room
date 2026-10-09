# Telegram: adapter, transport, rotation, live status

Sources: `server/channel-adapters/telegram.mjs`, `telegram-transport.mjs`,
`telegram-rotation.mjs`, `telegram-config.mjs`, `server/channel-live-status.mjs`,
`server/channel-import.mjs` (webhook inbox), `server/channel-drain.mjs`.

## Adapter (`telegram.mjs`) — normalize recorded Updates only

No bot token, fetch, webhook registration, or send API lives here.

- `normalizeTelegramUpdate(connection, update)` — raw Bot API Update →
  canonical envelope. `updateKind` classifies `message | edited_message | channel_post`;
  anything else (callbacks, member changes) → `null`, skipped by the importer.
- `message.id` is chat-qualified: `"<chatId>:<messageId>"` (Telegram message ids
  are unique per chat only). `replyTo` likewise.
- Attachments: largest `photo` size + one entry per `document|audio|video|voice|sticker|animation|video_note`
  (max 20, duplicate attachment ids rejected).
- `telegramUpdates(connection, response, { offset, limit })` — a getUpdates
  response → `{ changes, cursor, complete }`. **Duplicate `update_id`s in one
  page are rejected** (`update_id > previous`); cursor = next offset.
- `RecordedTelegramBot` — fixture reader (`getUpdates`/`submit`/`lookup`);
  `bind({ reader, connection })` exposes the uniform driver; `close()` only
  when the reader has a lifecycle.

## Transport (`telegram-transport.mjs`) — live sendMessage

Injected `fetch` (tests never hit the network); one outbox attempt ↔ one
operation key; retried submits replay the receipt store instead of re-posting.

- `telegramSendRequest(envelope)` (pure): builds `{ method: "sendMessage", body }`.
  **Ids travel as validated digit strings, never `Number()`** (M-25): a chat id
  above 2^53 would be silently corrupted. `reply_parameters` for replies,
  `message_thread_id` for topics. Body ≤ 4096 chars.
- `retryableTelegramStatus(status)` — `429` or `>= 500`. Retry uses bounded
  exponential backoff: `telegramRetryDelay({ attempt, retryAfter })` =
  `min(maxDelayMs, retryAfter*1000 or baseDelayMs * 2^attempt)`;
  defaults: 4 attempts, 500 ms base, 5 s cap, 10 s request timeout.
- Outcomes: `accepted` (receipt `telegram:<chat>:<msgId>`), `rejected`
  (400/403 definitive — stored, never retried), or thrown `ServiceError`
  (401/404 → 409 `channel_connection_unavailable`; exhausted retries →
  503 `channel_sending_unavailable`, with `Retry-After` on 429).
- **At-least-once trade-off (documented)**: after an ambiguous network failure
  the first POST may already have been accepted; the retry re-POSTs with no
  idempotency key (Bot API has none) — a duplicate message is possible.
  Blast radius is bounded to in-flight retries of one attempt.
- `redactTelegram(text)` masks `bot<digits>:<token>` shapes in error text;
  descriptions from the provider are slugified into the receipt `code`.

## Webhook secret rotation (`telegram-rotation.mjs`)

The plaintext secret **never reaches the server**: `connection.webhook` keeps
only SHA-256 digests.

- `generateWebhookSecret()` — 32 random bytes base64url (43 chars); always
  passes the strength gate.
- `startWebhookRotation({ webhook, newSecretHash, windowMs, at })` — new digest
  verifies immediately; previous digest stays accepted until
  `rotationExpiresAt`. Window: 1 s – 7 d (default 24 h). Requires an existing
  registered secret; new ≠ old.
- `webhookAcceptsHash(webhook, presentedHash, now)` — constant-time compare
  (`timingSafeEqual`) against current digest, or previous digest while the
  rotation window is open.
- `webhookRotationState` — `none | pending | complete`; `webhookRotationView`
  exposes state + window expiry to the connection card (digests never).
- Strength gate (`channel-import.mjs`): `validateWebhookSecret` — 16–256
  chars, no whitespace/controls, ≥ 6 distinct chars; enforced both where the
  plaintext enters (`ChannelWebhookInbox.hash`) and at receive time.

## Live status (`channel-live-status.mjs` + `telegram-config.mjs`)

- `TelegramLiveStatus` (telegram-config) is process-memory only.
- `DurableTelegramLiveStatus` is the durable replacement: one row per
  `(account, connection)` in `telegram_live_status`, upserted on write.
  **Never carries the bot token or webhook secret** — counters/timestamps only.
- `received(accountId, connectionId, { at, count })` — replaces
  `last_update_received_at`, accumulates `received_updates`.
- `sent(accountId, connectionId, { at, outcome, code })` — replaces the latest
  result (no history kept). Outcome/code length-bounded (32/64).
- `snapshot()` returns the zero-value shape when no row exists.
- `connectionId` coerces `null` → `""` (direct sends carry no stored connection).
- `verify()` — offline integrity: counters non-negative, outcome/code within
  column bounds; `verifySchema({ allowAbsent })` — a pre-table file opens
  read-only without migrating; a *partial* schema still fails.

## Ingest path (webhook → journal → drain)

1. `ChannelWebhookInbox.receive({ connectionId, secret, body })` — matches the
   secret (constant-time, epoch + state + `profileChannel === "telegram"`
   checked), validates the body (one Update or `{ updates: [...] }`, ≤ 100,
   safe-integer `update_id`s, 64 KB body cap), journals via `channel-journal`.
   Redelivered update ids are no-ops (PK). Un-normalizable message updates are
   journaled straight to `failed` with the contract code — refusing them (4xx)
   would make Telegram redeliver and stall its queue.
2. `ChannelDrainer.tick()` (60 s default, `CHANNEL_DRAIN_INTERVAL_MS`; ≤ 0
   disables) — `scan()` finds telegram connections with pending rows
   (oldest-backlog first, max 25/cycle); `poisonScreen()` parks un-importable
   updates with bounded attempts; `drainConnection()` imports the slice through
   an injected `importSlice` authority — **currently null (B20)**: drains report
   an honest `channel_drain_unavailable` deferral instead of importing.
   Overlap-safe (`#inflight` set); never throws (per-connection results).
3. `syncTelegramConnection` — account-session sync of one recorded page;
   retried syncs return the journaled receipt only for identical content
   (`sameRecording` replays the pure path and compares digests); drained
   slices acknowledge exactly the consumed update ids in the page transaction.

## Failure modes

| Failure | Behavior |
|---|---|
| Weak webhook secret | 422 `weak_webhook_secret` at hash time and receive time |
| Wrong secret / unknown connection | 401 `channel_webhook_denied`, nothing journaled |
| Backlog > 500 (`webhookBacklog`) | 409 `channel_webhook_backlog`, delivery refused unchanged |
| Poison update | parked `failed` after 5 attempts; neighbours unaffected |
| Bot token 401/404 | 409 `channel_connection_unavailable` |
| 429/5xx/network on send | bounded retry → 503 `channel_sending_unavailable` (+ `Retry-After` when hinted) |
| Expired rotation window | previous digest stops verifying automatically |

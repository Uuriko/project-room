# Unified inbox: one connection record, one adapter interface

The private Inbox reads messages from more than one platform through one
account-owned import path and shows them in one list. Email (Microsoft Graph
shaped) and Telegram (Bot API shaped) are the first two channels. Email is
fixture driven: no credentials, network calls or real sends exist for it in
this tree. Telegram has a live path (webhook in, `sendMessage` out, a reply box
in the Inbox) that is inert until a person sets two deployment bindings; no
token or secret is in code, tests, docs or journals. See
[Live Telegram](#live-telegram-zero-spend) and
[Fixture versus live](#fixture-versus-live) below. The ordered human steps to switch
Telegram and email on in production, and the checks that prove they are
live, are in [GO-LIVE-CHECKLIST.md](GO-LIVE-CHECKLIST.md). A live email provider still
needs its own reviewed slice and separate authorization, exactly as
[CURRENT-ROOM.md](CURRENT-ROOM.md) says for a real mailbox.

## Connection record

`server/channel-connection.mjs` validates the generic record. Extra or unknown
keys are rejected, as with every other inbox contract.

```json
{ "accountId": "acct-…", "id": "telegram-fixture", "revision": 1,
  "channel": "telegram", "provider": "telegram-bot", "externalId": "7000000001",
  "identity": { "kind": "bot", "id": "7000000001", "handle": "@fixture_room_bot", "displayName": "Fixture Room Bot" },
  "capabilities": { "read": true, "send": true, "threads": true, "edit": true },
  "state": "active" }
```

- The owner configures the *profile* (the record without `state`); `state` is
  `active`, `disconnected` or `reconnect_required` and is derived from the
  stored connection and the account's current authorization epoch.
- `identity` and every message participant share one shape:
  `{ kind, id, handle, displayName }` with `kind` in mailbox, user, bot, chat,
  group, channel.
- Email keeps its historical Graph-shaped profile (`mailboxId`, `identity`
  address, `aliases`) in journals and envelopes. `emailConnection()` is a thin
  wrapper that validates through the generic record; `toChannelProfile()` maps
  either stored shape onto the record for the connections API.
- Storage: connections live in the existing `private_email_connections` table
  (`store.connections`, an alias of `store.email`). The table name predates
  multi-channel support; `provider` and `mailbox_id` hold the generic
  `provider`/`externalId`, and `channel` lives in `data_json`. No schema bump.
- Webhook journal: verified provider updates are rows of
  `pending_channel_updates` (`server/channel-journal.mjs`, `store.channelUpdates`),
  keyed by (account, connection, provider `update_id`) with `received_at`, the
  raw `payload`, `status` pending / imported / failed, `attempts` and
  `last_error`. The table is purely additive at schema 27, exactly like
  `wake_queue` (W4-45) and the attention tables (W4-46): no data migration, no
  writer-fence impact (a pre-journal writer has no code path to it) and the
  recovery audit's exact table list is the integrity gate. A read-only open of a
  backup taken before the journal still verifies (`verifySchema({ allowAbsent })`,
  the PR #135 pattern); a writable open adds the table. Nothing in the route
  touches SQL: `ChannelWebhookInbox` writes only through `store.channelUpdates`.

## Adapter interface

`server/channel-adapters/index.mjs` maps `provider` to an adapter module. Each
module exports `channel`, `provider`, `readEnvelope(value)`,
`sourceId(connection, messageId)`, `scope(envelope)` and
`bind({ reader, connection, … })`, which returns the uniform driver:

```
{ channel, provider,
  normalize(raw) -> envelope,
  changes({ cursor }) -> { changes: [{ messageId, action }], cursor, complete },
  hydrate(messageId) -> raw | null,
  submit({ operationId, envelope }) -> { operationId, previewVersion, outcome, providerId },
  lookup({ operationId }) -> receipt | null }
```

`server/channel-import.mjs` drives any bound adapter into a `page.apply`
request (`prepareChannelFixturePage`) and the importer (`store.connections.apply`)
persists it. The same `plan()` handles email and Telegram pages: connection
scope, cursor progress, per-source revisions and `source.import` into the
Inbox under the import authority. `Inbox` refuses a source that changes its
channel origin.

## Envelope

Every imported source is `{ adapter: <channel>, envelope }`. Email envelopes are
unchanged. Telegram envelopes:

```
{ contractVersion: 1, channel: "telegram", sourceId, sourceVersion, connection,
  message: { id: "<chatId>:<messageId>", revision: "<update_id>", threadId, kind,
             sentAt, editedAt, from, to: [chat], subject: null, replyTo },
  body: { format: "text", content },
  attachments: [{ id, kind, name, contentType, size }] }
```

`sourceId = "telegram-" + sha256([accountId, provider, externalId, message.id])`,
the same digest style as `emailSourceId`. Attachments carry descriptors only,
never bytes. Edited messages are new versions of the same source. Callback
queries and other non-message updates are skipped by `changes()` and rejected by
`normalize()`.

The browser reads Telegram sources through the `channel-text-v1` /
`channel-excerpt-v1` projection (text, participant labels, chat title,
attachment count, connection state). Chat ids, file ids, update cursors and bot
ids stay off that path. Excerpt sharing into a room works like email.

## Routes (account session; cookie, session binding, CSRF)

| Route | Purpose |
| --- | --- |
| `GET /api/inbox/connections` | Generic records for the account's connections |
| `GET /api/inbox/connections/{id}` | One record plus `mode`, `webhook`, `syncAvailable` |
| `POST /api/inbox/connections/{id}/sync` | Import one recorded Telegram page `{ requestId, updates }` (at most 100 updates); `updates: null` drains the oldest pending journal rows. Each sync consumes at most 50 updates and reports `receipt.complete: false` when more remain, so a larger backlog drains over repeated syncs with fresh request IDs. The page and the acknowledgement of exactly the rows it consumed commit in one transaction. Loopback-only **and** fixture-mode only |
| `POST /api/inbox/connections/{id}/reconnect` | Owner-authenticated live import trigger (account session, CSRF, 30/min per account) that works from any client, including the hosted Worker. When the Telegram bindings are set it first stores the SHA-256 of `TELEGRAM_WEBHOOK_SECRET` on the connection (`registered: true`), then drains the oldest pending journal rows through the same sync path (`updates: null`). Returns the connection record plus `live` status |
| `POST /api/inbox/connections/commands` | Owner-managed connection records from the browser: exactly one `connection.configure` (add or update a bot or mailbox profile; the profile's `accountId` must be the caller's) or `connection.disconnect` ("Remove") request as the connections journal takes it. Account session, CSRF, origin, 30/min per account. `connection.webhook` and `page.apply` are refused with 422 `invalid_channel_connection`. Returns the connection record plus `live`, the receipt and `duplicate` |
| `POST /api/inbox/channel-sends` | Reply from the Inbox: `{ action: "dispatch" \| "reconcile", sourceId, sendId }` drives an attempt the send journal already holds (`send.reserve` over `/api/inbox/commands`) through the deployment's transport for the source's connection. Account session, CSRF, 30/min per account. 409 `channel_sending_unavailable` for email, samples and inactive connections. Returns the send list, the attempt, `channelSend: { provider, mode }` and the connection's `lastSendResult` |
| `POST /api/inbox/webhooks/{connectionId}` | Provider callback. `X-Telegram-Bot-Api-Secret-Token` is compared in constant time against the SHA-256 stored by `connection.webhook`; accepted updates are journaled durably (`pending_channel_updates`) and a redelivered `update_id` is a no-op in every status. A scheduled drainer (`server/channel-drain.mjs`, 60 s by default: server interval in `server.mjs`, Worker cron in `cloudflare/room.mjs`) poison-screens the pending slice on schedule; the inbox import step stays owner-session bound until the B20 system import authority exists, so slices are honestly deferred, never imported without one. At most 500 pending rows per connection (409 `channel_webhook_backlog`, delivery refused unchanged). Body up to 64 KB; 60 deliveries per minute per verified connection behind a 1200 per minute per-address guard (see [Webhook contract](#webhook-contract)). Inert unless the server is started with a `ChannelWebhookInbox` |

`GET /api/inbox/connections/{id}` adds `webhookSetAt` and, for Telegram, a
`live` block (`state` not_configured / invalid / configured, the binding
names, `webhook` unset / set / matches / differs, `lastUpdateReceivedAt`,
`lastSendResult`, `importAvailable`). It names bindings and states only; a
token, secret or hash never appears in a response.

Webhook secret and state (B49). `ChannelWebhookInbox.hash` is the only place a
plaintext secret enters the server; it accepts 16–256 characters without
whitespace or control characters and with at least 6 distinct characters (422
`weak_webhook_secret`), and a presented secret outside that rule is refused
before any compare. Choose at least 32 random bytes (64 hex characters). A
delivery is accepted only while the connection is `active` for the account's
current auth epoch: a `reconnect_required` or `disconnected` connection answers
401 `channel_webhook_denied` and journals nothing. A retried `sync` with the
same `requestId` returns the journaled receipt only when it carries the same
recording (or is a drain, `updates: null`); different `updates` answer 409
`idempotency_conflict`.

`GET /api/inbox?view=…` lists channel sources with a `connection`
reference and a `needsYou` flag (see [Needs you](#needs-you)); clients without
a negotiated view still see samples only. `GET /api/inbox/sources/{id}/sends`
and `/send-context` add `channelSend`: `null` when this deployment has no
transport for the source's connection, otherwise `{ provider, mode }` with
`mode` `live` (bindings set) or `fixture` (inert sender). The Telegram excerpt
view's `capabilities.send` is `true` on an active bot connection whose record
allows sending; email stays `false`.

## Send

`sendPreview` produces a review-only preview for synthetic samples and Telegram
sources. A Telegram preview names the bot connection and its target chat
(`target: { chatId, replyToMessageId, threadId }`). `SyntheticInboxTransport`
dispatches an attempt only when the adapter's `kind` equals the preview's
provider (`synthetic` for samples, `telegram-bot` for Telegram); the fixture
`RecordedTelegramBot` doubles as that transport and records what it would have
sent. The queued / unknown / accepted / rejected journal is unchanged. The
browser shows no send panel for channel sources in this pilot.

From the browser, a Telegram source with `capabilities.send` shows the same
reply controls as a sample: save the draft, **Preview reply**, then **Send**.
The dialog and the status line say which transport answers: "Reply on
Telegram" / "Sent by the bot into the chat as a reply" when the bindings are
set, "Sample Telegram reply" / "Sample only · Telegram is not configured here,
nothing is sent" otherwise. `POST /api/inbox/channel-sends` dispatches or
reconciles the queued attempt; the states are the journal's:

| Journal state | Browser (live) | Browser (fixture) | Cause |
| --- | --- | --- | --- |
| `queued` | Reply ready · not sent | Sample reply ready · not sent | `send.reserve` |
| `unknown` | Outcome unknown · check status | Sample outcome unknown | dispatch started; Telegram unreachable, busy or 5xx after retries (`lastSendResult.outcome = failed`, `code` network / rate_limited / server_error) |
| `accepted` | Accepted by Telegram · delivery unconfirmed | Sample accepted · nothing left this server | `sendMessage` ok; `providerId` `telegram:<chat>:<message>` (`fixture:<operation>` for the fixture) |
| `rejected` | Rejected by Telegram · not sent | Sample rejected · not sent | 400/403 from Telegram, `lastSendResult.code` is the slugged description |
| `cancelled` | Cancelled · not sent | Sample cancelled · not sent | `send.cancel` while queued |

Route-level refusals use the shared codes: 409 `channel_sending_unavailable`
(email, samples, disconnected connection, or Telegram still unavailable after
retries) and 409 `channel_connection_unavailable` (Telegram refused the bot
token). Email sources show "Sending unavailable" until an outbound email slice
exists (B23).

`server/channel-adapters/telegram-transport.mjs` is the live counterpart:
`telegramSendAdapter({ config, fixture, fetch })` returns the fixture bot when
the bindings are not set and a `TelegramTransport` (kind `telegram-bot`) when
they are. The transport POSTs `sendMessage` (chat id, text, `reply_parameters`,
forum `message_thread_id`) through an injected `fetch`:

- Idempotency: one outbox attempt is one operation key
  (`SyntheticInboxTransport.correlation`, a digest of account, send id and
  preview version). A retried `submit` with the same key replays the recorded
  receipt without posting again; a different preview under the same key is a
  `conflicting_inbox_observation`; concurrent submits share one HTTP attempt.
  Receipts live in an injectable `get`/`set` store (a `Map` by default) so the
  durable journal can persist them later.
- Retry: 429 waits `parameters.retry_after` seconds (capped at 5 s per wait),
  5xx and network failures back off 500 ms, 1 s, 2 s; at most 4 attempts.
- Error mapping: success is `accepted` with `providerId`
  `telegram:<chatId>:<message_id>`; 400/403 is a definitive `rejected`
  receipt; 401/404 (bad token) is 409 `channel_connection_unavailable`;
  exhausted 429/5xx/network is 503 `channel_sending_unavailable` (with
  `Retry-After` when Telegram gave one) and the attempt stays `unknown` in the
  send journal for reconciliation. The token appears only in the request URL
  and is redacted from every error string.

## Connection lifecycle: configure, reconnect, remove

Every connection is a record in the account's connections journal
(`server/email-import.mjs`, `store.connections`). The journal is append-only;
"remove" is a state change, never a deletion, so imported messages remain
readable as saved copies.

| Step | Command | From the browser | Effect |
| --- | --- | --- | --- |
| Add | `connection.configure` with `expectedRevision: 0` and a profile at revision 1 | **Add connection** under the connection cards: Telegram bot (connection id, bot id, bot username, optional name) or email mailbox (connection id, address, optional name) | `state: active`; at most 20 connections per account; one connection per bot id or mailbox (`email_mailbox_exists`) |
| Update or re-add | `connection.configure` with the current revision | Add connection with an existing id | Profile revision moves; provider and external id may not change (`email_mailbox_changed`); a disconnected record becomes active again |
| Register the webhook secret | `connection.webhook` (server side only) | **Reconnect** on a Telegram card when the bindings are set | Stores the SHA-256 of `TELEGRAM_WEBHOOK_SECRET`; the record's revision does not move |
| Rotate the webhook secret | `connection.webhook.rotate` (server side only; Reconnect starts it when the binding changes) | **Reconnect** on a Telegram card after re-registering with `scripts/telegram-set-webhook.mjs` | Stores the new SHA-256 and keeps the old one accepted until `rotationExpiresAt`; `connection.webhook.complete` ends the window early; the card shows `live.rotation` as pending (with window expiry) or complete |
| Import | `page.apply` under the import authority | **Reconnect** (drains verified webhook updates) | New or edited sources appear in the list |
| Remove | `connection.disconnect` | **Remove**, then **Confirm remove** (or **Keep**) | `state: disconnected`; cards lose Reconnect and Remove; sources show "Disconnected · saved copy"; replies are refused with `channel_sending_unavailable`; a later `connection.configure` re-adds it |

Authorization epochs: a connection whose `authEpoch` differs from the
account's current epoch reads `reconnect_required` and cannot import or send
until it is configured again.

## Webhook contract

- URL: `https://<room origin>/api/inbox/webhooks/<connection id>`, `POST`,
  JSON body. Telegram sends one `Update` per request; the route also accepts
  `{ "updates": [ … ] }` (up to 100) for tests and replays.
- Authentication: header `X-Telegram-Bot-Api-Secret-Token`, compared in
  constant time with the SHA-256 the connection stores. Unknown connection and
  wrong secret both answer 401 `channel_webhook_denied`; nothing else is
  disclosed.
- Answers: 202 `{ connectionId, received, pending }` when the updates are
  held; 409 `channel_webhook_unavailable` when the deployment has no
  `ChannelWebhookInbox`; 409 `channel_webhook_backlog` when the per-connection
  hold is full (Telegram retries later); 422 `invalid_channel_update` for a
  body that is not an update; 413 `too_large` above 64 KB
  (`channelSyncLimits.webhookBodyBytes`: a reply embeds the replied-to message,
  so this route alone is above the 16 KB every other JSON route keeps; the
  journal's per-update `payloadBytes` matches it); 429 `rate_limited` above 60
  deliveries per minute per verified connection (`webhookPerConnection`,
  counted after the secret matches and before anything is journaled, so
  Telegram's shared egress addresses never share one budget), behind a guard
  of 1200 requests per minute per client address (`webhookPerAddress`) for
  unverified traffic.
- Journaling, not importing: a verified update is written durably to
  `pending_channel_updates` (one row per connection and `update_id`; a
  redelivered id is a no-op; at most 500 pending rows per connection) and
  waits until the owner presses **Reconnect** (or calls the trigger). Import
  runs under the import authority through the same `page.apply` path as
  recorded fixtures, so duplicates and edits are handled by the journal. See
  [Webhook journal lifecycle](#webhook-journal-lifecycle).
- Allowed update kinds: `message`, `edited_message`, `channel_post`; callback
  queries and member changes are skipped by `changes()` and refused by
  `normalize()`.

## Secrets handling

Names only; values never appear in code, tests, docs, journals, logs or API
responses.

| Name | Where it lives | Who reads it | Never |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Worker secret / local env | `telegramConfig()` accessor; the transport puts it in the outbound URL only | in a response, a card, a journal or an error string (`redactTelegram`) |
| `TELEGRAM_WEBHOOK_SECRET` | Worker secret / local env, and Telegram's `setWebhook` call | `connection.webhook` stores only its SHA-256; the webhook route compares hashes; `scripts/telegram-rotate-webhook.mjs --generate` mints a fresh one | in a response or card (`live.webhook` reports unset / set / matches / differs only; `live.rotation` reports pending / complete with the window expiry) |
| `TELEGRAM_API_BASE` | optional var | `telegramConfig()` | — |
| Account access keys, session cookies, CSRF | browser + server session tables | every inbox route (`protectWrite`) | in URLs or bodies of inbox routes |

The **Add connection** form asks for a bot id and username, never a token; the
form says so. Email fixtures carry no credentials at all.

## Fixture versus live

| Piece | Today | Becomes live when |
| --- | --- | --- |
| Email inbound | Recorded Graph fixtures; cards read "Inbound: fixture mailbox · not yet routed" | Cloudflare Email Routing hands mail to the Worker (#144: `server/mime-message.mjs`, `server/email-routing-inbound.mjs`, `docs/EMAIL-ROUTING.md`) and the Worker's `email()` handler is mounted |
| Email outbound | None; sources say "Sending unavailable", `capabilities.send: false` | An outbound email slice (B23) |
| Attachment bytes | Never retained; the reader lists descriptors (name, type, size) and downloads stay unavailable | A live provider fetch slice that downloads bytes with the account's credentials, reusing the phase-4 auth, ownership, and membership path |
| Telegram inbound | Webhook route verifies and journals (`pending_channel_updates`); Reconnect imports | `TELEGRAM_BOT_TOKEN` and `TELEGRAM_WEBHOOK_SECRET` are set and `setWebhook` is registered |
| Telegram outbound | `FixtureChannelSender` answers "accepted" locally; labels say "Sample"; `lastSendResult.code = fixture` | The same two bindings; `TelegramTransport` posts `sendMessage` |
| Connection records | Real journal rows, live today | — |
| Needs-you marker, filters, sharing | Live today over whatever is imported | — |

## Needs you

A message "needs you" when it addresses the account owner directly, decided by
the pure selector `inboxNeedsYou` in `server/inbox.mjs` (a view over stored
facts, never a stored flag, in the same spirit as `needsAttention` in
`src/work-selectors.js`):

- Email: the connection's mailbox address or one of its aliases is in **To**
  (CC alone does not count).
- Telegram: the message came from a private chat with the bot, mentions the
  bot's `@handle`, or replies to a message the bot itself sent (a `providerId`
  the send journal recorded as accepted or delivered).

The list marks such rows "Needs you", the reader adds "Addressed to you", and
the Inbox tab shows "(N need you)" the way a room's Catch-up shows its count.
The W4-46 delivery model (quiet hours, digest) is room scoped and untouched;
the Inbox marker is per account and does not enter the wake queue.
## Webhook journal lifecycle

1. `receive` matches the connection and secret, validates the Telegram Update
   shape and journals every update in one store transaction. A message-kind
   update the adapter cannot normalize (for example an unsupported chat type) is
   written straight into `failed` with the contract code as `last_error` and
   `attempts` at the bound, so it never occupies the pending backlog or a sync
   attempt; the delivery still answers 202, because a 4xx would only make the
   provider redeliver the same update and stall its own queue behind it.
   Duplicates (same `update_id`, any status) are not written again.
2. `sync` with `updates: null` takes the oldest 100 pending rows. As a
   backstop, a pending update the adapter can no longer normalize records one
   failed attempt with the contract code, leaves this page and is offered again
   next time, so it never blocks the updates around it. After
   `channelJournalLimits.maxAttempts` (5) it parks as `failed` and is no longer
   offered; the row keeps its payload and error for a later connection card.
3. The recorded reader pages the remaining slice at 50 updates. The page apply
   and the `imported` mark of exactly the rows below the returned cursor commit
   together; rows behind the reader's page stay `pending`.
4. If the page itself fails, every row in the slice records one attempt with the
   error code (422, 5xx or an unexpected error); authority and state conflicts
   (401, 403, 404, 409: session, connection changed, stale page) are not the
   updates' fault and count nothing.
5. `store.channelUpdates.verify()` (store open and recovery audit) checks that
   each payload names its key, attempts stay within the bound and only exhausted
   rows are `failed`.

## Worker mount (proposal for Grok)

`cloudflare/room.mjs` is Grok's area, so this tree does not change it. On the
Worker the webhook route currently answers 409 `channel_webhook_unavailable`
because no `ChannelWebhookInbox` is passed to `createRoomServer`. With the
journal in the store, the mount is one import and one option; the proposal PR
`claude/build-01-webhook-journal-worker-mount` carries exactly this diff:

```diff
--- a/cloudflare/room.mjs
+++ b/cloudflare/room.mjs
@@
 import { RoomStore } from '../server/store.mjs';
 import { createRoomServer } from '../server/http.mjs';
+import { ChannelWebhookInbox } from '../server/channel-import.mjs';
@@
     this.server = createRoomServer({ store: this.store, origin: env.ROOM_ORIGIN, assetRoot: origin, serviceMode: 'cloudflare-staging',
+      // Verified provider webhook updates are journaled in the Durable Object's
+      // SQLite (pending_channel_updates), so they survive eviction and restart.
+      channelWebhooks: new ChannelWebhookInbox(this.store),
       resolveRequestSignal: () => this.requestSignals.getStore(),
```

Nothing else is required for the journal itself. With the mount in place the
owner drains the journal from anywhere through `POST
/api/inbox/connections/{id}/reconnect` (the loopback-only `/sync` stays for
local recordings), and the bot token and `setWebhook` registration follow the
Live Telegram steps below; the bindings are set by John or Grok, never in code.

## Spam guard and quiet hours

Inbound scoring extends `server/inbox-spam.mjs` and notification delivery
extends `server/notify-prefs.mjs`; both are pure modules the import path calls
into, and neither touches login/auth.

**Spam guard** (`server/inbox-spam.mjs`):
- `flagMessage(value, { context })` — the original body-only scan is unchanged
  when `context` is omitted. The context adds sender-reputation scoring
  (`reputationScore` 0..100), bulk-pattern detection (`recipients`,
  `burstCount`), and Telegram signals: bot impersonation (`botName`/`botHandle`/
  `senderHandle`), giveaway/airdrop lures, `t.me` join lures, and generic
  bot-spam phrasing.
- `createSenderReputation()` — per-sender history with outcomes
  `clean | flagged | quarantined | spam_confirmed`; labels `unknown | trusted |
  neutral | watch | bad`. A single `spam_confirmed` or three quarantines marks
  a sender `bad`, which feeds the `bad_reputation` signal (25) on future mail.
- `createQuarantineQueue()` — quarantined mail is **never silently dropped**:
  it enters an owner-review queue as `pending` and stays there until an owner
  `review()`s it `release` (back to the inbox) or `confirm_spam`. Records are
  final and retained after review, with reviewer and timestamp. The live
  import path files to `SpamQuarantineJournal` instead (durable); this queue
  remains as the pure in-memory reference. Auto-quarantine policy itself is
  John's call (task 33); the guard ships flag-only by default.
- `SpamQuarantineJournal` (`server/spam-quarantine-journal.mjs`, on
  `store.spamQuarantine`) — the durable backing for the quarantine queue: a
  `spam_quarantine` table (additive, unfenced, `IF NOT EXISTS`) holding
  `held → released | dismissed` records with the flag's signal list as the
  reason, the reviewer, and timestamps. Held rows survive process restarts
  and Durable Object evictions; reviews are final. `review()` speaks the
  in-memory queue's `release | confirm_spam` decision vocabulary
  (`confirm_spam` maps to `dismissed`).

**Quiet hours** (`server/notify-prefs.mjs`):
- `setQuietHours(userId, { start, end, tz })` — a half-open local window
  `[start, end)` ("HH:MM", IANA tz; overnight wrap supported; `start === end`
  disables).
- `setConnection(userId, { connectionId, channel, batching, quietHours })` —
  per-connection schedule with optional quiet-hours override and
  `batching: immediate | digest`.
- `decideNotification(userId, { connectionId, urgent, at })` returns one of
  `deliver | hold | muted`: muted levels silence everything; `urgent: true`
  (set by the SLA-breach path) delivers even in quiet hours; non-urgent pings
  inside quiet hours — or on a `digest`-batched connection — are `hold`ed for
  the morning digest. Re-deciding the same payload when the window ends
  returns `deliver`, which is how held items release.

**Import wiring** (`server/inbox-import-guards.mjs`, tasks 32/34): the
`source.import` branch of `Inbox.apply` — the single funnel every channel
import lands through (email/Telegram fixtures, the webhook drain, the live
poller) — runs both guards on every imported envelope. `scoreImportedEnvelope`
maps the envelope onto a scannable message (Telegram envelopes also carry the
room bot's name/handle for the impersonation signal) and journals
`receipt.spam = { score, signals, quarantine }`; `decideImportedNotification`
runs the store-owned notify-prefs manager (account id as user id) and journals
`receipt.notify = { decision, reason, at, connectionId, urgent, prefs }`, the
prefs snapshot included so the journal replay recomputes the decision from the
recorded inputs. Flag-only (task 33): nothing is held, hidden, or moved —
scoring never blocks ingestion (an unscannable envelope records score 0).

When the flag trips (`receipt.spam.quarantine`), the import branch also files
the message in `SpamQuarantineJournal` (`store.spamQuarantine`) as a `held`
record for owner review — the durable switch away from the in-memory
`createQuarantineQueue`, which loses its queue on restart. The journal write
rides the same store transaction as the receipt (duplicate `requestId`s
short-circuit before it, so retries never double-journal), and a journal
failure never blocks ingestion. Owner review goes through the journal's
`review()`, which speaks the queue's `release | confirm_spam` vocabulary
(`confirm_spam` maps to `dismissed`); reviews are final. The message itself
still lands in the inbox — the journal is the review backlog, not a hide.

## Status: email is fixture only; Telegram is live once configured

The email adapter reads recorded fixtures: no mailbox is polled and nothing is
sent. Telegram's live path exists but does nothing until the two bindings below
are set; without them every connection card reads "Live: not configured" and
imported messages arrive only from `scripts/*-contract-fixture.mjs` recordings
and tests. The Inbox empty state says so in the browser.

## Live Telegram (zero spend)

The Telegram Bot API is free. Nothing here goes live until a person (John or
Grok) sets the bindings; no value is ever committed, logged or returned.

### Bindings

| Binding | Set by | Purpose |
| --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | Worker secret / local env | Bot API token from @BotFather (`<bot id>:<35 chars>`). Used only in the outbound request URL. |
| `TELEGRAM_WEBHOOK_SECRET` | Worker secret / local env | 16-256 characters of `A-Z a-z 0-9 _ -`, chosen by the person. Telegram echoes it in `X-Telegram-Bot-Api-Secret-Token`; the connection stores only its SHA-256. |
| `TELEGRAM_API_BASE` | optional var | Defaults to `https://api.telegram.org`; only for a self-hosted Bot API server. |

`server/channel-adapters/telegram-config.mjs` reads them
(`telegramConfig(env)`) into a frozen object with `state`
(`not_configured` / `invalid` / `configured`), `missing`, `invalid` and
accessor functions for the values, so serializing the config never leaks
them. `createRoomServer({ telegram })` takes that object; `server.mjs` passes
`telegramConfig(process.env)`. On the Worker the `nodejs_compat` runtime
populates `process.env` from vars and secrets, so the default
`telegramConfig()` sees the bindings without a `room.mjs` change (an explicit
`telegram: telegramConfig(env)` in `cloudflare/room.mjs` is the tidier form
once that file is next edited).

### Setup steps

1. Create the bot: talk to @BotFather in Telegram, `/newbot`, copy the token.
   Add the bot to the group or channel it should read; for groups, disable
   privacy mode (`/setprivacy`) or make it an admin so it receives messages.
2. Set the bindings on the Worker (values are prompted, never typed into a
   file or commit):

   ```sh
   cd cloudflare
   pnpm exec wrangler secret put TELEGRAM_BOT_TOKEN
   pnpm exec wrangler secret put TELEGRAM_WEBHOOK_SECRET
   ```

   Locally, export the same two variables before `npm start`.
3. Add the connection: in the Inbox, open **Add connection**, keep
   "Telegram bot", choose a connection id (it becomes part of the webhook
   URL), enter the bot id (the digits before the colon in the token) and the
   bot's username, press **Add**. This sends `connection.configure` to
   `POST /api/inbox/connections/commands`; the same request works from a
   script with the account session.
4. Open the Inbox and press **Reconnect** on the Telegram card (or `POST
   /api/inbox/connections/{id}/reconnect`). It stores the SHA-256 of
   `TELEGRAM_WEBHOOK_SECRET` on the connection so deliveries are accepted, and
   the card changes from "Webhook: not registered" to "Webhook: registered".
5. Register the webhook with Telegram from any machine that has the two
   variables:

   ```sh
   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
     node scripts/telegram-set-webhook.mjs https://<room origin> --connection <connection id> --dry-run
   TELEGRAM_BOT_TOKEN=… TELEGRAM_WEBHOOK_SECRET=… \
     node scripts/telegram-set-webhook.mjs https://<room origin> --connection <connection id>
   ```

   The expected webhook URL is
   `https://<room origin>/api/inbox/webhooks/<connection id>`. The dry run
   prints the request with the secret redacted and sends nothing; the live
   run calls `setWebhook` with `secret_token` and
   `allowed_updates: [message, edited_message, channel_post]`, prints
   Telegram's answer, and exits 1 if it was not `ok`. `--delete` calls
   `deleteWebhook`; `--drop-pending` discards updates Telegram still holds.
6. Send a message to the bot's chat. Telegram POSTs to the webhook route,
   which verifies the secret in constant time and holds the update; the card
   shows "Last update received". Press **Reconnect** (or call the trigger) to
   import it. Accepted updates are journaled durably in `pending_channel_updates`
   (`server/channel-journal.mjs`); the server must be started with a
   `ChannelWebhookInbox`, which `cloudflare/room.mjs` does.

### Email setup (fixture today; #144 merged the parser, routing still pending)

1. In the Inbox, **Add connection**, choose "Email mailbox (fixture)", enter
   the address and a name. The card reads "Inbound: fixture mailbox · not yet
   routed" and "Sending: not available". Recorded fixtures import through
   `scripts/*-contract-fixture.mjs`; nothing polls a mailbox.
2. To route real mail (#144 is merged: `server/mime-message.mjs`, `server/email-routing-inbound.mjs`; still pending: the Worker `email()` mount in `cloudflare/room.mjs` and the rules below, see [EMAIL-ROUTING.md](EMAIL-ROUTING.md)): enable Email Routing on the domain (or a subdomain such
   as `mail.<domain>`), accept the MX and SPF records Cloudflare adds, add a
   routing rule per address (or the domain catch-all) with the action "Send
   to a Worker" pointing at the room Worker, and agree the address scheme
   (one connection per mailbox, plus-addressing for tags, an optional
   `*@domain` alias for catch-all). No secret, token or paid plan is involved.
   See `docs/EMAIL-ROUTING.md` on that branch for caps and the handler
   proposal.
3. Outbound email remains a separate slice (B23).

### Connection cards and the list

`src/inbox-ui.js` renders one card per connection under the message list:
channel and bot or mailbox name, connection state, and for Telegram the live
lines (`Live: not configured · set …` / `Live: configured`, `Webhook: …`,
`Last update received`, `Last send`) plus **Reconnect**; email cards read
"Inbound: fixture mailbox · not yet routed" and "Sending: not available".
Every active card has **Remove**, which asks for a second click (**Confirm
remove** or **Keep**) instead of a native dialog. **Add connection** opens the
form described above. The card and its API never show a token, secret, hash,
chat id or bot id.

The list shows every channel together, each row with a channel badge (Email,
Telegram, Sample) and a "Needs you" mark when applicable. Two labelled selects
filter by channel and by connection; "Group by connection" (on by default)
keeps one section per connection, off gives one flat list, newest first.
Rows stay buttons with `aria-current` on the open message; the filters are a
`role="group"` named "Filter messages".

## Error codes

Codes that apply to every channel are named `channel_*`:
`channel_sending_unavailable` (send gate in `inbox-outbox.mjs`, the email
adapter's `submit`/`lookup`, and `POST /api/inbox/channel-sends` when no
transport applies), `channel_sharing_unavailable`,
`channel_connection_unavailable`, `channel_connection_not_found` (connection
routes, 404), `channel_importer_required`, `channel_account_mismatch`
(`connection.configure` and `source.import` observations; 422 over HTTP),
`invalid_channel_connection` (422: the commands route saw something other
than `connection.configure` or `connection.disconnect`),
`channel_observation_scope_changed`, `channel_sync_page_limit` and the
`channel_webhook_*` / `channel_sync_*` codes in `channel-import.mjs`
(`channel_webhook_backlog` is now the journal's pending bound). The live
transport reuses `channel_sending_unavailable` (Telegram unreachable, busy or
not configured) and `channel_connection_unavailable` (bad bot token).
Codes tied to the Graph email import contract keep their historical `email_*`
names (folders, cursors, delta pages, reply plans, `email_fixture_*` for the
recorded mailbox reader) because their payloads are email specific. The
connections journal shares a few of them across channels because the table
predates multi-channel support: `stale_email_connection` (409, the record
moved; refresh), `email_mailbox_exists` (a second connection for the same bot
or mailbox), `email_mailbox_changed` (an id reused for a different bot or
mailbox), `email_connection_limit` (20 per account), `email_connection_changed`
(import or webhook on an inactive record). The send journal's own codes are
`stale_inbox_reply`, `inbox_send_unresolved`, `inbox_reply_already_sent`,
`inbox_send_not_found`, `stale_inbox_send`, `inbox_send_started`,
`conflicting_inbox_observation` and `inbox_transport_mismatch`.

## Adding a platform (Slack, Discord, SMS)

1. Add the provider under its channel in `channelProviders`
   (`server/channel-connection.mjs`).
2. Add `server/channel-adapters/<platform>.mjs` exporting the module interface
   above, a `Recorded<Platform>` fixture reader with a cursor that matches the
   platform's paging, and a fixture in `scripts/<platform>-contract-fixture.mjs`
   with invented data only. Register it in `channel-adapters/index.mjs` (the
   registry throws at load time if a provider has no adapter).
3. Accept the new `adapter` value where the Inbox projects sources
   (`summary`, `channelView` in `server/inbox.mjs`) and in the browser
   validators (`src/inbox-client.js`).
4. Add the new server files to `scripts/runtime-package.mjs` and
   `scripts/candidate-runtime-fixture.mjs`; add tests and coverage-map claims.
5. Keep the fixture-first stance: no tokens in code, fetch only through an
   injected function, sends only through a transport that is inert until its
   bindings are set (see Live Telegram above for the pattern).

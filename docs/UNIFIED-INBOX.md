# Unified inbox: one connection record, one adapter interface

The private Inbox reads messages from more than one platform through one
account-owned import path. Email (Microsoft Graph shaped) and Telegram (Bot API
shaped) are the first two channels. Email is fixture driven: no credentials,
network calls or real sends exist for it in this tree. Telegram has a live path
(webhook in, `sendMessage` out) that is inert until a person sets two
deployment bindings; no token or secret is in code, tests, docs or journals.
See [Live Telegram](#live-telegram-zero-spend) below. A live email provider
still needs its own reviewed slice and separate authorization, exactly as
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
| `POST /api/inbox/webhooks/{connectionId}` | Provider callback. `X-Telegram-Bot-Api-Secret-Token` is compared in constant time against the SHA-256 stored by `connection.webhook`; accepted updates are journaled durably (`pending_channel_updates`) until the owner syncs, and a redelivered `update_id` is a no-op in every status. At most 500 pending rows per connection (409 `channel_webhook_backlog`, delivery refused unchanged). Inert unless the server is started with a `ChannelWebhookInbox` |

`GET /api/inbox/connections/{id}` adds `webhookSetAt` and, for Telegram, a
`live` block (`state` not_configured / invalid / configured, the binding
names, `webhook` unset / set / matches / differs, `lastUpdateReceivedAt`,
`lastSendResult`, `importAvailable`). It names bindings and states only; a
token, secret or hash never appears in a response.

`GET /api/inbox?view=…` lists channel sources with a `connection`
reference; clients without a negotiated view still see samples only.

## Send

`sendPreview` produces a review-only preview for synthetic samples and Telegram
sources. A Telegram preview names the bot connection and its target chat
(`target: { chatId, replyToMessageId, threadId }`). `SyntheticInboxTransport`
dispatches an attempt only when the adapter's `kind` equals the preview's
provider (`synthetic` for samples, `telegram-bot` for Telegram); the fixture
`RecordedTelegramBot` doubles as that transport and records what it would have
sent. The queued / unknown / accepted / rejected journal is unchanged. The
browser shows no send panel for channel sources in this pilot.

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
3. Configure the connection record for the bot (channel `telegram`, provider
   `telegram-bot`, `externalId` = the bot id, `identity.kind` = `bot`) through
   the connections journal (`connection.configure`). The connection id you
   choose is part of the webhook URL.
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
   import it. Until the durable webhook journal lands, held updates live in
   process memory and the Worker must be started with a `ChannelWebhookInbox`.

### Connection card

`src/inbox-ui.js` renders one card per connection under the message list:
channel and bot name, connection state, and for Telegram the live lines
(`Live: not configured · set …` / `Live: configured`, `Webhook: …`, `Last
update received`, `Last send`) plus **Reconnect**. The card and its API never
show a token, secret, hash, chat id or bot id.

## Error codes

Codes that apply to every channel are named `channel_*`:
`channel_sending_unavailable` (send gate in `inbox-outbox.mjs` and the email
adapter's `submit`/`lookup`), `channel_sharing_unavailable`,
`channel_connection_unavailable`, `channel_connection_not_found` (connection
routes, 404), `channel_importer_required`, `channel_account_mismatch`
(`connection.configure` and `source.import` observations),
`channel_observation_scope_changed`, `channel_sync_page_limit` and the
`channel_webhook_*` / `channel_sync_*` codes in `channel-import.mjs`
(`channel_webhook_backlog` is now the journal's pending bound). The live
transport reuses `channel_sending_unavailable` (Telegram unreachable, busy or
not configured) and `channel_connection_unavailable` (bad bot token).
Codes tied to the Graph email import contract keep their historical `email_*`
names (folders, cursors, delta pages, reply plans, `email_fixture_*` for the
recorded mailbox reader) because their payloads are email specific.

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

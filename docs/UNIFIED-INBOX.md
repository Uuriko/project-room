# Unified inbox: one connection record, one adapter interface

The private Inbox reads messages from more than one platform through one
account-owned import path. Email (Microsoft Graph shaped) and Telegram (Bot API
shaped) are the first two channels. Everything is fixture driven: no
credentials, bot tokens, network calls, webhook registration or real sends
exist in this tree. A live provider needs its own reviewed slice and separate
authorization, exactly as [CURRENT-ROOM.md](CURRENT-ROOM.md) says for a real
mailbox.

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
| `POST /api/inbox/webhooks/{connectionId}` | Provider callback. `X-Telegram-Bot-Api-Secret-Token` is compared in constant time against the SHA-256 stored by `connection.webhook`; accepted updates are journaled durably (`pending_channel_updates`) until the owner syncs, and a redelivered `update_id` is a no-op in every status. At most 500 pending rows per connection (409 `channel_webhook_backlog`, delivery refused unchanged). Inert unless the server is started with a `ChannelWebhookInbox` |

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

Nothing else is required for the journal itself. What the mount does not give
you yet: the drain (`POST .../sync`) is loopback-only, so on the Worker updates
accumulate durably but are imported only once B21 adds an owner-authenticated,
non-loopback import trigger; and the Telegram bot token and `setWebhook`
registration are B21 work that needs a Worker secret binding set by John or
Grok, never in code.

## Status: fixtures only

Every adapter in this tree reads recorded fixtures. There is no live ingestion
path: no provider is polled, no webhook is registered with a provider, and the
webhook route only journals updates for a connection the owner has already
configured with a secret (durably since B20; the Worker mount is a separate
proposal, see above). The Inbox empty state says so in the browser
("Email and Telegram connections are local fixtures for now; no live messages
arrive and nothing is sent"). Until a separately authorized live slice exists,
imported messages arrive only from `scripts/*-contract-fixture.mjs` recordings
and tests.

## Error codes

Codes that apply to every channel are named `channel_*`:
`channel_sending_unavailable` (send gate in `inbox-outbox.mjs` and the email
adapter's `submit`/`lookup`), `channel_sharing_unavailable`,
`channel_connection_unavailable`, `channel_connection_not_found` (connection
routes, 404), `channel_importer_required`, `channel_account_mismatch`
(`connection.configure` and `source.import` observations),
`channel_observation_scope_changed`, `channel_sync_page_limit` and the
`channel_webhook_*` / `channel_sync_*` codes in `channel-import.mjs`
(`channel_webhook_backlog` is now the journal's pending bound).
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
5. Keep the fixture-only stance: no tokens, no fetch, no send. A live driver is
   a separate, separately authorized slice.

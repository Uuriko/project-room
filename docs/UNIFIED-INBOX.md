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
| `POST /api/inbox/connections/{id}/sync` | Import one recorded Telegram page `{ requestId, updates }`; `updates: null` drains verified webhook updates. Loopback-only **and** fixture-mode only |
| `POST /api/inbox/webhooks/{connectionId}` | Provider callback. `X-Telegram-Bot-Api-Secret-Token` is compared in constant time against the SHA-256 stored by `connection.webhook`; accepted updates wait in memory until the owner syncs. Inert unless the server is started with a `ChannelWebhookInbox` |

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

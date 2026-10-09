# WhatsApp, Messenger, SMS adapters

Sources: `server/channel-adapters/whatsapp.mjs`, `messenger.mjs`, `sms.mjs`.

All three normalize **recorded** provider payloads only — no access tokens,
webhook verification, fetch, or live send API. Limits: 16 KB body (SMS 4 KB),
0 attachments (media arrives in a later slice), 100 updates/page, 1 MiB input.

## WhatsApp (`whatsapp-cloud`)

- `normalizeWhatsappPayload(connection, payload)` — Meta
  `whatsapp_business_account` webhook body →
  `{ envelopes, skipped }`. **Only text messages normalize**; every other
  message type is listed under `skipped` with
  `unsupported_whatsapp_message_type:<type>` (never silently dropped).
  Status-only changes carry no messages and are ignored; a non-WhatsApp
  `messaging_product` is refused loudly.
- `normalizeWhatsappUpdate(connection, { value, message })` — one text message
  → envelope. `message.id = "<phone_number_id>:<wamid>"` (wamids unique per
  business number); `revision` = sent-at seconds; `threadId` =
  `<numberId>:<sender>`; `replyTo` from `message.context.id`.
- `whatsappUpdates(connectionValue, response, { offset, limit })` — recorded
  delivery batch → `{ changes, skipped, cursor, complete }`.
- `RecordedWhatsAppCloud` — fixture reader over recorded payload batches.
- `bind({ reader, connection })` — **outbound is off by design (B23)**:
  `submit()`/`lookup()` throw `ContractError("channel_sending_unavailable")`.
  There is no fixture send path, so the driver refuses instead of pretending.

## Messenger (`messenger-api`)

- `eventKind(event)` — classifier: exactly one known shape per event:
  `message` (has `message.mid`), `postback` (has `postback.payload`),
  `read_receipt` (`read`), `optin` (`optin`). **Unknown shapes → `null`,
  skipped by the importer with positions recorded, never normalized.**
- `normalizeMessengerEvent(connection, page, event)`:
  - message: id `<page>:<mid>`; quick-reply payload (if any) goes in the
    opaque `revision` slot; empty text allowed.
  - postback: id `<page>:<mid or postback-<ts>>`; the tap **payload** is the
    `revision`; body = title or payload.
  - read_receipt: id `<page>:read:<watermark>`; empty body allowed.
  - optin: id `<page>:optin:<ts>`; empty body allowed.
- `normalizeMessengerWebhook(connection, payload)` — `{ object: "page",
  entry: [{ id, messaging: [...] }] }` → `{ envelopes, skipped }`.
- PSIDs/mids/page ids are opaque strings (PSID = 1–32 digits); webhook
  timestamps are Unix millis clamped to the ISO range.
- `RecordedMessengerPage` — fixture reader + fixture send path
  (`submit`/`lookup` with operation-keyed receipts, correlation-conflict check).
  `bind()` `changes()` pages the recorded events with a numeric string cursor.

## SMS (`sms-gateway`)

- `normalizeSmsWebhook(connection, payload)` — inbound SMS → envelope;
  `normalizeSmsStatusCallback(connection, payload)` — delivery receipts →
  `message | delivery_receipt` kinds with statuses
  `queued | sent | delivered | failed | undelivered`.
- `concatenationInfo(payload)` — multipart reassembly info.
- `RecordedSmsGateway` — fixture reader; `bind()` mirrors the uniform driver.

## Cross-cutting notes

- Envelope `to` is exactly one participant (`count(m.to, 1)`); message ids are
  always recipient-qualified (`<to.id>:<id>`) and must start with the
  recipient prefix — prevents cross-recipient id confusion.
- `*_input_limit` (1 MiB serialized) is checked before any normalization, so a
  hostile payload cannot blow memory before validation.
- All three adapters' `bind` readers require the matching fixture class
  (`instanceof` check) — a telegram reader cannot be bound to the whatsapp
  adapter (`whatsapp_fixture_reader_required` etc.).

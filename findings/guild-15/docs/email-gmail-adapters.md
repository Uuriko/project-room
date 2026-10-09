# Email + Gmail adapters (channel-adapters)

Sources: `server/channel-adapters/email.mjs` (microsoft-graph),
`server/channel-adapters/gmail.mjs` (gmail-api).

## Email (`microsoft-graph`)

- `readEnvelope` / `sourceId` / `scope` (scope = `envelope.message.folderId`).
- `normalizeRoutedEmail(connection, parsed, { envelopeFrom, envelopeTo, receivedAt, rawDigest })` —
  Cloudflare Email Routing inbound → envelope. Outbound is `none`
  (`emailRoutingCapabilities`: `transport: "cloudflare-email-routing"`,
  `inbound: "live-via-routing"`, `outbound: "none"`).
- `rawEmailDigest(raw)` — base64 → `emailDigest`.
- `bindRouting({ connection, messages })` — fixture bind for routed mail.
- `bind({ reader, connection, folderId })` — the Graph reader bind (fixture
  `RecordedGraphMailbox` mirrors the telegram recorded bot).

## Gmail (`gmail-api`)

- `gmailConnection(value)` — validates the generic profile, then requires
  `provider === "gmail-api"` (`requireEmail`).
- `normalizeGmailMessage(connection, message, { labelId = "INBOX" })` — a Gmail
  API `messages.get(format=full)` resource → envelope via the shared email
  envelope shape (`readEnvelope = readEmailEnvelope`, `sourceId = emailSourceId`).
- `gmailListChanges(connectionValue, labelId, response)` — a `messages.list`
  response → page descriptor; `qualifyGmailCursor(cursor)` validates cursors.
- `RecordedGmailMailbox` — fixture reader; `bind({ reader, connection, labelId })`.
- HTML bodies are sanitized by the vendored sanitizer
  (`server/vendor/gmail-html-sanitizer.mjs`): allowlisted tags/attributes,
  `https|http|mailto` schemes only, no protocol-relative URLs, links forced to
  `target=_blank rel="noopener noreferrer"`, HTML boundary enforced.

## Shared email envelope

Both providers produce the same envelope contract the email importer expects
(see `docs/adapter-interface.md`); `scope` is the folder id so one connection
can back several folders. `emailDigest` canonicalizes for replay comparison
(the same digest style the telegram adapters use: sorted-key canonical JSON →
SHA-256).

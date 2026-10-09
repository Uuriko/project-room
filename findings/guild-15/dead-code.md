# Dead code — channels slice (reachability evidence)

Method: every `export`ed symbol in the slice was grepped textually across
`server/ scripts/ tests/ src/ relay/ docs/`. Symbols below have **exactly one**
textual reference in the entire repo: their own definition line. No dynamic
access (`obj["name"]`, re-export barrels) exists for these names — verified by
the same grep. Listed as dead *exports*; the functions themselves may be
intentionally-kept API, so nothing was deleted.

## Dead exports

### 1. `notConfiguredTelegram` — server/channel-adapters/telegram-config.mjs:41
```js
export const notConfiguredTelegram = () => telegramConfig({});
```
Single reference: its own line. `telegramConfig` itself is live; this
convenience wrapper has no caller (not even tests).

### 2. `startWebhookRotation` — server/channel-adapters/telegram-rotation.mjs:41
The rotation-begin constructor (`{ secretHash, previousSecretHash,
rotationExpiresAt, rotationState: "pending", ... }`). No caller anywhere —
notably `scripts/telegram-rotate-webhook.mjs` (the operator rotation script)
imports only `generateWebhookSecret, hashRotationSecret,
webhookRotationDefaults` from this module and never calls
`startWebhookRotation`. Either the script inlines the record construction or
the begin-path is unreachable from operations.

### 3. `completeWebhookRotation` — server/channel-adapters/telegram-rotation.mjs:53
The end-rotation-early path. No caller; rotation expiry is automatic
(`webhookRotationState` flips `pending` → `complete` at
`rotationExpiresAt`). The early-complete operation is unreachable.

### 4. `startGmailSync` — server/gmail-sync.mjs:109
The standalone 60 s interval starter (`startGmailSync(mailbox, intervalMs)`).
The `GmailSync` *class* is live (`server/jobs.mjs:447` wires it into the job
context; `server/routes/inbox.mjs:125` uses `mailboxTick` on demand), but the
interval starter itself is never invoked — background Gmail sync only runs if
the job runner ticks it.

## Internally-used-but-never-imported exports (not dead, noted)

These are used inside their own module but never imported elsewhere; the
export is likely test/API surface, kept intentionally:

- `retryableTelegramStatus` (telegram-transport.mjs) — used by `TelegramTransport`; no external import.
- `channelCapabilities`, `participantKinds` (channel-connection.mjs) — used by `channelProfile`/`channelParticipant`.
- `channelJournalStatuses` (channel-journal.mjs) — used by `verify()`.
- `GMAIL_CALLBACK` (gmail-mailbox.mjs) — used by `gmailConfig`.
- `BREAKER_FAILURES_TO_OPEN`, `BRIDGE_HEARTBEAT_MS`, `TOKEN_DERIVATION_CONTEXT`, `resolveBridgeRoute`
  (session-adapter/herdr-bridge-adapter.mjs) — used internally.
- `createTelegramEnvelope`, `createWhatsappEnvelope`, `createMessengerEnvelope`, `createSmsEnvelope`,
  `telegramInput`, `whatsappInput`, `messengerInput`, `smsInput`, `*Limits` — used internally or by tests
  via namespace import; envelope constructors are the canonical builders behind `normalize*`.

## Not dead (alias trap)

- `projectGmailMessage` (gmail-content.mjs) shows only 2 textual refs because
  `gmail-actions.mjs` imports it **aliased** (`projectGmailMessage as project`).
  Live.

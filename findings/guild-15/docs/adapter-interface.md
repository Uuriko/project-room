# Channel adapter interface contract

Source: `server/channel-adapters/index.mjs` + `server/channel-connection.mjs`.

## Registry

`channelAdapters` is a `Map` keyed by **provider id** → adapter module. At import
time the module asserts every `(channel, provider)` pair in `channelProviders`
has an adapter whose `.channel` matches — a missing platform adapter is a
startup throw, not a runtime surprise.

```js
export const channelProviders = Object.freeze({
  email: ["microsoft-graph", "gmail-api"],
  telegram: ["telegram-bot"],
  whatsapp: ["whatsapp-cloud"],
  sms: ["sms-gateway"],
  messenger: ["messenger-api"],
});
```

Lookups: `adapterFor(provider)` (throws `ContractError("unsupported_channel")`
on miss), `adapterForChannel(channel)` (first provider of the channel),
`adapterForProfile(profile)`, `readChannelEnvelope(value)` (dispatches on the
envelope's declared `channel`; each adapter re-derives and re-checks it).

## The uniform driver interface

Every adapter module exposes the registry surface:

```
{ channel, provider, readEnvelope, sourceId, scope, bind }
```

`bind({ reader, connection, ... })` returns the driver the importer uses:

```
{ channel, provider,
  normalize(raw),        // raw provider shape -> canonical envelope (pure)
  changes({ cursor }),   // one page: { changes, cursor, complete }
  hydrate(id),           // full raw for one change id (or null)
  submit(request),       // send-side; throws ContractError when unavailable
  lookup(request),       // send receipt lookup
  close?() }             // only when the reader has a lifecycle (live pollers)
```

## Envelope shape (all adapters)

`{ contractVersion: 1, channel, sourceId, sourceVersion, connection, message, body, attachments }`

- `sourceId` = `"<channel>-" + sha256(accountId, provider, externalId, messageId)` — stable, provider-scoped.
- `sourceVersion` = digest of the canonical content — replay comparison uses it.
- `connection` is the validated `channelProfile` (see below).
- `message`: `{ id, revision, threadId, kind, sentAt, editedAt, from, to, subject, replyTo }`
  with `from`/`to` as `channelParticipant`s.
- `readEnvelope(value)` re-normalizes and re-digests, then requires
  `contractVersion === 1`, matching `channel`, `sourceId`, and `sourceVersion`
  (`*_version_mismatch` on drift) — envelopes are self-verifying.

## Connection contract (`channel-connection.mjs`)

Data contract only: **no credentials, network, persistence, or send authority.**

- `channelProfile(value)` — exact-fields validated profile:
  `accountId, id, revision (> 0, safe integer), channel, provider, externalId, identity, capabilities`.
  Unknown channels/providers → `unsupported_channel`.
- `channelCapabilities(value)` — exact `{ read, send, threads, edit }` booleans.
- `channelParticipant(value)` — exact `{ kind, id, handle, displayName }`;
  kinds: `mailbox | user | bot | chat | group | channel`. Text is
  well-formed, control-char-free, byte-capped.
- `channelConnection(value)` — profile + `state` in
  `active | disconnected | reconnect_required`. Extra keys rejected.
- `toChannelProfile(profile)` — maps the legacy Graph email shape
  (`mailboxId`, `identity.address`) onto the generic record without rewriting stored data.
- `connectionState(connection, authEpoch)` — `disconnected` wins; epoch drift →
  `reconnect_required`; else `active`.
- `exactFields(v, keys)` — rejects any extra key. This is load-bearing:
  forward-compat fields are intentionally refused so new provider data cannot
  slip through unvalidated.

## Text/id/timestamp validation (shared pattern in every adapter)

- `text(value, max, { empty, multiline })`: well-formed UTF-8, non-blank unless
  `empty`, byte-capped, control chars rejected (multiline allows tab/LF/CR).
- `timestamp(value)`: strict `YYYY-MM-DDTHH:MM:SS(.ffffff)Z` ISO, round-trip
  checked (`toISOString().slice(0,19) === value.slice(0,19)`) — rejects
  impossible dates like month 13.
- Raw provider timestamps (Unix seconds/millis) are clamped to the ISO range
  Date can format (year 9999); a hostile date is a 422 contract error, never a
  `RangeError` from `toISOString`.
- Input-size gates: `telegramInput`/`whatsappInput`/`messengerInput`/`smsInput`
  JSON-serialize first and enforce a 1 MiB cap (`*_input_limit`).

## Gotchas

- `ContractError extends TypeError` but sets `name = "EmailContractError"`
  (historical). Catch sites match on `.name`, not `instanceof`.
- `adapterForChannel` silently picks the **first** provider of a channel —
  for `email` that's `microsoft-graph`, never `gmail-api`.
- `submit()` on whatsapp/sms fixture drivers throws
  `ContractError("channel_sending_unavailable")` by design (outbound off).

# Channel journal + webhook secret relay

Sources: `server/channel-journal.mjs`, `server/channel-adapters/webhook-secret.mjs`.

## `ChannelUpdateJournal` (B20) — durable webhook update store

One row per `(account, connection, provider update id)` in
`pending_channel_updates`: a verified update survives restart/eviction and
waits for the owner's import. **Nothing here fetches, sends, or registers.**

- `record(accountId, connectionId, updates, { backlog, rejected })` —
  idempotent by update id (`ON CONFLICT DO NOTHING` — a redelivery in any
  status is left exactly as-is). Rows the adapter already refused go straight
  to `failed` with attempts at the bound (`parked`). Payloads byte-capped at
  64 KB (matches the webhook route body cap — a reply embeds the replied-to
  message). **The whole delivery is refused unchanged when the pending backlog
  would exceed the bound** (409 `channel_webhook_backlog`).
- `pending({ limit })` — oldest first; `limit: null` returns the whole backlog.
- `imported(ids)` — marks exactly these pending rows `imported`; one statement
  per row because a legal 500-id batch plus scope binds exceeds Durable Object
  SQL's 100-bind limit.
- `failed(ids, error)` — `attempts+1`, bounded error text (200 chars); rows
  reaching `maxAttempts` (5) park as `failed` and stop being offered — one
  poison update cannot block a connection forever. Returns `{ attempted,
  exhausted, error }`.
- `verify()` — offline integrity: payload's `update_id` matches its key,
  attempts within bound, `failed` ⟺ attempts exhausted, attempted rows carry
  `last_error`, `updated_at >= received_at`. Throws → operator reconciliation.
- `verifySchema({ allowAbsent })` — a pre-journal file opens read-only without
  migrating; a partially-present schema still fails.
- Purely additive schema (`CREATE TABLE IF NOT EXISTS` + index), outside the
  writer fence (older writers have no code path here).

Limits: `maxAttempts 5`, `payloadBytes 65536`, `errorChars 200`, `batch 500`.
Statuses: `pending | imported | failed`.

## Outgoing relay webhooks (`webhook-secret.mjs`) — Slack/Discord (HB-1a)

The URL is a credential: validated, sealed with AES-256-GCM, never copied
into an error message. Delivery is a direct POST. Nothing here is mounted on
a route.

- `keyBytes(key)` — 32-byte Buffer or 64-hex string; else `RelayError`.
- `assertRelayUrl(url, { hosts, pathPrefix })` — `validateWebhookUrl` + caller
  allowlist + **SSRF guard**: https only, no userinfo/port/hash/query, host in
  allowlist, path under prefix, private/reserved addresses refused.
- `sealWebhookUrl(url, key, check)` / `openWebhookUrl(sealed, key, check)` —
  AES-256-GCM with AAD `"relay-webhook"`; `open` re-validates length, canonical
  base64url round-trip, and runs `check(url)` again; every failure mode throws
  `RelayError("invalid_webhook_secret")` — no oracle.
- `postWebhook({ url, body, fetchFn, sleep, timeoutMs, lookup, now })` — one
  POST with a 5 s abort timeout. **429 handling**: waits out `Retry-After`
  when the wait fits the 5 s budget and retries once; a longer wait returns
  `{ delivered: false, status: 429, retryAt }` so the caller defers without
  blocking. Network/timeout failures return `{ delivered: false, status: 0,
  reason }`. The URL is never part of the result. `redirect: "error"`.

## Gotchas

- Journal `failed()` only transitions `pending` rows — already-`failed` rows
  are untouched (attempts don't grow past the bound).
- `record()` counts `accepted` as rows *written*; redeliveries bump `received`
  but not `accepted`.
- `postWebhook`'s `retryDelayMs` accepts numeric or HTTP-date `Retry-After`;
  unparseable → 1 s default.

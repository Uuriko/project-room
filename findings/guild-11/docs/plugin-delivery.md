# Plugin-store delivery guarantees (guild-11 slice docs)

Source: `server/agent-plugin-store.mjs` (class AgentPluginStore, mounted as
`store.agentPlugin`). Pure subscription logic lives in
`server/agent-webhook-subscriptions.mjs`; signing/transport in
`server/outbound-webhooks.mjs`.

## Durable journal (agent_webhook_deliveries)

One row per (event, subscription) delivery:

- `delivery_id` TEXT PRIMARY KEY; `idempotency_key` TEXT NOT NULL UNIQUE.
- `state`: pending -> delivered | failed (-> retry) -> dead_letter.
- `target_url` overrides the subscription URL for wakeUrl pushes
  (NULL = the subscription's own URL).
- The idempotency key is `<eventId>:<subscriptionId>[:<suffix>]` when the
  event has an id, else `manual:<deliveryId>`. The UNIQUE constraint makes
  fan-out double-delivery impossible even if an event is applied twice — and
  even across restarts.

## buildWebhookDelivery — exactly-once journaling

1. Compute the idempotency key; SELECT first — a replay returns the existing
   row flagged `{ duplicate: true }` WITHOUT burning a delivery id in the
   pure module's counter.
2. `validateWebhookUrl(url)` when a target override is supplied (bad stored
   wakeUrls are skipped, never thrown — the wake path must not break).
3. Sign the delivery (`signDelivery` over deliveryId/eventType/issuedAt/data)
   and build the envelope; INSERT OR IGNORE (belt-and-braces behind the SELECT).
4. `persistJournal(subscriptionId)`.

Mutation u13/u14 proved the test suite pins the wake-event filter and the
prune batch continuation flag; fuzz f12 proved 10 concurrent same-signal
wake pings journal exactly 1 row.

## Retry and prune

- `recordWebhookAttempt(deliveryId, { ok, error })`: ok -> delivered,
  else -> failed with `attempts+1` and `last_error`.
- `pruneWebhookDeliveries()`: keeps the newest `WEBHOOK_DELIVERY_KEEP`
  (100) rows per subscription plus the `WEBHOOK_DELIVERY_RETENTION_MS`
  (7-day) window; NEVER touches pending/failed rows; deletes at most
  `WEBHOOK_DELIVERY_PRUNE_BATCH` (500) rows per tick and reports
  `moreMayRemain: true` when the batch was full so the cron continues.
- `hydrateDeliveries(subscriptionId)`: newest-100-per-subscription cache,
  oldest-first in memory, via the `(subscription_id, created_at)` index
  (no correlated scan — pinned by tests/webhook-delivery-load.test.js).
- Skipped deliveries (disabled subscription / unlinked identity) recheck after
  `SKIPPED_RECHECK_MS` (10 min) — currently unpinned by tests (gap note).

## Dispatch

Deliveries flush fire-and-forget after the request path returns
(`setDispatchKick` by the entry point; the cron tick is the restart-safe
backstop). `dispatchKick` is null in tests — deliveries then wait for the
cron tick / manual drain. `kickDispatch()` never throws.

## Secrecy

- Raw signing secrets are NEVER returned over HTTP (RC-2026-09-27-2729) —
  views carry an opaque `secretRef`; inbound verification is server-side
  (`verifyWebhookDelivery`).
- wakeUrl is never exposed in directory cards (it is a secret delivery
  target); journal projections reveal no message payload.

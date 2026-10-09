# Retry / backoff / failure modes across the slice

## Retry & backoff

| Component | Policy |
|---|---|
| Telegram send (`telegram-transport.mjs`) | Bounded exponential backoff on 429 (honors provider `retry_after`) and 5xx/network: `min(5000, retryAfter*1000 or 500*2^attempt)`, 4 attempts, 10 s per-request timeout (`AbortSignal.timeout`). 429-with-hint failures surface `Retry-After` on the final 503. |
| Slack/Discord relay (`webhook-secret.mjs`) | One POST, 5 s abort timeout. A 429 waits out `Retry-After` **only if the wait fits the 5 s budget**, then tries once more. A longer `Retry-After` returns `{ delivered: false, status: 429, retryAt }` — the caller defers without blocking. |
| Webhook secret rotation (`telegram-rotation.mjs`) | No retry: verification dual-accepts old+new digests for the rotation window (default 24 h), so in-flight deliveries survive rotation without any retry logic. |
| Gmail sync (`gmail-sync.mjs`) | Exponential backoff on tick failures: `min(1h, 60s * 2^min(failures,6))`. `reconnect_required` is sticky (no retry until the owner reconnects). |
| Channel drain (`channel-drain.mjs`) | Poison updates: bounded attempts (5), then parked `failed` — retry is per-tick, never infinite. Scheduler: a failed tick is counted and the next tick still fires; an in-flight tick skips the next beat (never stacked). |
| Journal import (`channel-journal.mjs`) | Attempt-bounded (5); only content/importer faults (422, 5xx, unexpected) consume attempts — authority/state conflicts (401/403/404/409) never do. |
| Gmail actions (`gmail-actions.mjs`) | **No retry of the provider request, ever.** Reserve-before-effect (`gmail_operations`): a crash/timeout leaves the row `unknown`; `reconcile()` heals by matching `rfc822msgid` against the provider's sent/draft list. Replays never repeat the side effect. |
| Gmail HTTP (`gmail-mailbox.mjs`) | 15 s timeout per request; no retry at the HTTP layer (idempotency lives in the operation journal instead). |

## Idempotency

- Gmail mutating actions: `(account_id, request_id)` journal with content
  fingerprint — replay returns the recorded result; fingerprint mismatch →
  `gmail_request_conflict`.
- Telegram fixture sends / messenger fixture sends: operation-keyed receipt
  stores; a retried submit with the same key replays the receipt; a key reused
  with different content → correlation conflict (409).
- Webhook deliveries: PK `(account, connection, update_id)` — redelivery is a
  no-op in any status.
- Sync request ids: a retried `syncTelegramConnection` returns the journaled
  receipt only when `sameRecording` proves identical content.

## Failure-mode quick reference

| Failure | Code surfaced |
|---|---|
| Weak webhook secret | 422 `weak_webhook_secret` |
| Webhook secret mismatch | 401 `channel_webhook_denied` |
| Backlog full | 409 `channel_webhook_backlog` |
| Poison update | parked `failed` after 5 attempts |
| Bot token invalid | 409 `channel_connection_unavailable` |
| Telegram 429/5xx exhausted | 503 `channel_sending_unavailable` (+ `Retry-After` when hinted) |
| Send budget exhausted | 429 `send_budget_exhausted` (+ `Retry-After`) |
| Gmail refresh 4xx | `gmail_reconnect_required` (sticky) |
| Mid-flight session change | `gmail_session_changed` — aborts |
| Drain without import authority | `channel_drain_unavailable` (honest deferral, B20) |
| Journal/schema drift | "requires operator reconciliation" (fail closed) |

## Gotchas

- The telegram at-least-once trade-off is deliberate and documented: after an
  ambiguous network failure the retry may duplicate a message (Bot API has no
  idempotency key).
- `ChannelDrainer` without `importSlice` is the *normal* state today (B20) —
  `deferred`, not broken.
- Gmail send budgets are intentionally unenforced ([JOHN]-gated task 17) —
  `check`/`view` are no-ops for the gmail channel; don't "fix" this.
- `receive()` journals poison updates as `failed` immediately rather than
  refusing them — a 4xx refusal would make Telegram redeliver and stall its
  own queue behind the poison update.
- Rotation windows are half-open: the previous digest verifies while
  `now < rotationExpiresAt` (strict); at exactly the expiry instant it stops.

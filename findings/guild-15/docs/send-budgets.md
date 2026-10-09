# Channel send budgets

Source: `server/channel-send-budgets.mjs`.

Per-connection send budgets (TASKS #41): a thin policy layer over the
token-bucket limiter (`server/token-bucket.mjs`) for the
`POST /api/inbox/channel-sends` path. Every `(channel, account, connection)`
gets its own bucket, so one noisy bot can never spend another connection's
budget or hammer the provider into a ban. Exhaustion is an honest HTTP 429
with a `Retry-After` header instead of a provider-side throttle.

## Config resolution (precedence order)

1. **Per-connection overrides**: JSON object in `CHANNEL_SEND_BUDGETS`,
   keyed `"channel:connectionId"`
   (e.g. `{"telegram:conn-9": {"perMin": 10, "burst": 5}}`).
   `parseConnectionBudgets` is total: malformed JSON or entries are **ignored**,
   never a startup failure — a typo degrades to the channel default.
   Also accepts `per_min` / `sendsPerMin` key spellings.
2. **Stored connection record** `sendBudget` bag — currently a no-op
   placeholder (the connection contract rejects extra keys today).
3. **Channel env knobs**: `TELEGRAM_SEND_BUDGET_PER_MIN` /
   `TELEGRAM_SEND_BUDGET_BURST`, falling back to `CHANNEL_SEND_BUDGET_PER_MIN` /
   `CHANNEL_SEND_BUDGET_BURST`. Parsed by `number()`: finite and **> 0**, else
   the fallback (so `0` or garbage falls back to default rather than bricking
   or unlimiting the channel).
4. **Defaults**: 30 sends/min, burst 30.

`resolveSendBudget({ channel, env })` is pure — operators/tests can inspect it
without a registry. Returns `{ rate: perMin/60, burst: max(1, burst) }`.

## Gmail carve-out

Live Gmail send budgets are **NOT enforced here** — the Gmail send-slice
design (task 17) is [JOHN]-gated. `check`/`view` for the `gmail` channel are
documented no-ops returning `{ remaining: null, pendingApproval: true }`, and
the route layer must not call `check()` for gmail sends.

## Registry (`createSendBudgetRegistry`)

- `limiters` is a `Map` keyed `channel:accountId:connectionId` (null
  connectionId → `"direct"`), bounded by LRU eviction (`cacheSize`, default
  512) so stale connection ids can't accumulate.
- Buckets are keyed by a **config signature** (`rate/burst`): a config change
  transparently replaces the limiter instead of mixing old and new budgets.
- `now` injectable for tests.
- `check(scope, { now })` — validates the scope (channel + accountId required,
  else 500 `invalid_send_budget_scope`), consumes one token; on exhaustion
  throws 429 `send_budget_exhausted` with `Retry-After: max(1, ceil(retryAfterMs/1000))`.
- `view(scope, { now })` — non-consuming diagnostics for the channel-health
  card: `{ remaining, resetsAtMs }`; returns `null` for invalid scopes and for
  channels without budgets.

## Failure modes

| Situation | Behavior |
|---|---|
| Malformed `CHANNEL_SEND_BUDGETS` | ignored entry-wise; channel default applies |
| `perMin: 0` / negative / NaN in env | falls back (never a zero-rate brick) |
| `connectionBudget` lookup throws | degrades to env defaults |
| Budget exhausted | 429 + `Retry-After`; nothing was sent |
| Scope missing channel/account | 500 `invalid_send_budget_scope` (programmer error) |

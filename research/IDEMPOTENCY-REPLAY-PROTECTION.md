# Idempotency-Key + Replay-Protection Design (200-hard-tasks #3)

Reference implementation: `server/idempotency.mjs`
(`deriveKey`, `deriveEventKey`, `createDedupStore`, `executeOnce`).
Harness: `tests/idempotency.test.js` (11 tests, incl. the replay-attack and
reorg simulations).

## Key format

```
idem_v1_<scope>_<sha256(canonical(params))[:32 hex]>
```

- `scope`: 1–32 lowercase alphanumerics/dashes — the operation namespace
  (`payout`, `refund`, `chain-event`, `fund`).
- `params`: canonical JSON (sorted keys, no whitespace) of the operation's
  identity fields. **Deterministic**: the same params always produce the same
  key, so clients can retry safely and reorged chain events dedupe naturally.
- Regex: `^idem_v1_[a-z0-9-]{1,32}_[0-9a-f]{32}$`.

## Two-level keys

| level | key | dedupes | example params |
|---|---|---|---|
| intent | business operation, exactly-once | double payouts, double refunds | `{ jobId, amountRaw, chainId }` @ scope `payout` |
| event | chain event, exactly-once processing | reorg reinclusion, duplicate websocket deliveries | `{ chainId, txHash, logIndex }` @ scope `chain-event` |

A payout executes only when its **intent** key is new. A reorged-then-
reincluded chain event replays with the same **event** key and is deduped
before it ever reaches the payout intent. A *replacement* transaction for
the same job (different txHash) passes event dedup but hits the completed
intent key → returns the cached payout, no double-pay.

## Dedup store schema

```
idempotency_records (
  key TEXT PRIMARY KEY,          -- idem_v1_...
  status TEXT,                   -- in_progress | completed | failed
  result TEXT,                   -- canonical JSON of the completed result (nullable)
  error TEXT,                    -- failure message (nullable)
  created_at INTEGER,            -- ms epoch
  updated_at INTEGER,            -- ms epoch
  expires_at INTEGER             -- ms epoch; expired rows are forgotten
)
```

State machine per key:

```
begin:    none/expired/failed -> in_progress
          in_progress        -> IDEM_CONFLICT (HTTP 409: another attempt is running)
          completed          -> return cached result (HTTP 200, replayed: true)
complete: in_progress -> completed (stores result, extends TTL)
fail:     in_progress -> failed (stores error; next begin() retries fresh)
```

## Exactly-once payout semantics under reorg

1. Chain watcher emits `(chainId, txHash, logIndex)` → `deriveEventKey`.
2. `executeOnce(eventKey)`: replayed → stop. New → continue.
3. Derive the intent key from the *business* params (jobId, amountRaw, chainId).
4. `executeOnce(intentKey, payoutFn)`: exactly one execution across retries,
   replays, reorgs, and replacement transactions.
5. Refunds are separate intents (`scope: "refund"`): a refund after a
   completed payout is a new operation, never a replay.

## Retry rules

- Client retries **must** reuse the same key (derive it deterministically or
  store the first one).
- `IDEM_CONFLICT` (in_progress): back off and poll `GET` on the key; do not
  start a parallel attempt with a new key — that is how double-payouts happen.
- `failed`: safe to retry with the same key; the store replaces the record.
- `completed`: never re-execute; return the cached result with
  `replayed: true` so callers can distinguish.
- TTL: 24h default. After expiry the key is forgotten — retries past TTL are
  new operations (acceptable: no chain settlement should take 24h to confirm).

## Binding to the state machine (task #5)

`applyEvent`'s `eventId` dedup is the in-memory, single-process version of
this design. The idempotency store is the durable, cross-process version:
eventIds become intent keys (`scope: "job-event"`, params `{ jobId,
eventType, ... }`), and the state machine's `seenEvents` becomes the
`completed` result cache.

# Drop policies

## SSE consumer drops (`server/http.mjs` `stream()`)

| Policy | Value | Behavior |
|---|---|---|
| Per-connection send-queue cap | `streamQueueCap` (default 65536 bytes of `res.writableLength`) | Exceed → one `event: stream_lagging` ("reconnect with Last-Event-ID to resume"), then socket destroyed after `STREAM_DRAIN_GRACE_MS` (5000ms) if never drained |
| Global stream cap | 100 concurrent | Excess → `429 stream_limit` |
| Per-credential cap | 3 concurrent | Excess → `429 stream_limit` |

Drops are per-connection: a lagging consumer's destroy never affects peers.
After a drop the client resumes with Last-Event-ID from its last `id:` —
the server kept the cursor at the last sent event, so no gap.

## Wake-queue capacity (`server/wake-queue-limits.mjs`)

| Limit | Value | Enforced in |
|---|---|---|
| `active` | 200 pending+leased wakes per member | `enqueue()` → `409 wake_limit` (only when inserting a *new* key; coalescing an existing key is always admitted) |
| `receipts` | 5000 command receipts per member | `receiptCapacity()` → `409 wake_limit` on **every** writer: enqueue, pause, resume, requeue, complete. Exact-retry still returns the historical receipt at the cap. **Exception:** a state-changing pause is always admitted even at the cap (stop control must work); the matching resume stays capped and no-op re-pause is refused, so at most one extra receipt per breach. |
| `intentBytes` | 4096 | `enqueue()` → `422 invalid_wake` |
| `horizon` | 365 days | `enqueue()`/`requeue()` → `422 invalid_wake_time` |
| `maxAttempts` | 5 | `enqueue()` validation: `1 <= maxAttempts <= 5` → else `422` |
| `baseBackoffMs` / `maxBackoffMs` | 60000 / 3600000 | `fail()`: `min(base * 2^(attempts-1), max)` — bounded, deterministic |
| `leaseMs` | 30000 | `lease()`: holder has 30s; expiry → `recover()` returns it to pending |

## Dead-lettering

`fail()` moves a wake to `dead` when `attempts >= maxAttempts`. Dead wakes
park until `requeue()` (explicit, resets attempts to 0). `enqueue()` on a
dead key → `409 wake_dead`. `recover()` dead-letters expired leases whose
attempts are exhausted (M-18) instead of returning them to pending.

## Fuzz evidence (guild-12)

- F1/F14: stalled consumer → `stream_lagging` then socket destroy; peers kept
  receiving (pending — see `11-fuzz-load-report.md`).
- F8: 1000-enqueue flood → exactly 200 accepted, 800 refused `409`; receipt
  cap enforced; `PRAGMA integrity_check` ok (pending).
- F10: 300 pause/resume cycles — `due()` empty on every paused check (pending).

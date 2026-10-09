# Backpressure measurement — BEFORE vs AFTER

Harness: `tests/measure-backpressure.mjs` (boots a real local server per ref; local only).
BEFORE = `origin/main` @ `cb05aa5bf`. AFTER = `wave300/honest-backpressure` @ `10616ea72`.
Run: 2026-10-09 ~02:43–03:00 UTC. Raw JSON lost to /tmp reaper; numbers below are
transcribed verbatim from harness stdout observed by the coordinator.

## 1. Fanout: 200 concurrent POST /commands, 10s client timeout each

| metric | BEFORE | AFTER |
|---|---|---|
| 200/201 ok | 31 (15.5%) | 32 (16%) |
| fast 429 (responded <10s) | 112 (56%) | 168 (84%) |
| fast 503 | 0 | 0 |
| **silent timeouts (no status in 10s)** | **57 (28.5%)** | **0 (0%)** |
| 429 latency p50 / p95 | 5463ms / 9718ms | 6357ms / 6843ms |
| 429 by source | floodGuard 29, writeLimiter 83 | floodGuard 28, writeLimiter 140 |
| wall ms | 10320 | 7272 |

Reading: silent timeouts went 28.5% → 0%. The no-rearm fix removed the
retry-storm SQLite write amplification (every refused retry used to do a durable
bucket write on the hot path), so the event loop drains fast enough that every
request gets a status within the client timeout.

Honest caveat: 429s still take seconds under extreme saturation (p50 ~6s both
refs) because requests queue before the HTTP handler runs — the admission gate
only sheds once handlers execute. Shedding at the accept layer / server-side
request deadlines is follow-up work, out of this scope.

The 503 gate did not trigger in this fanout shape (handler-level in-flight never
exceeded 16); it is proven by the in-flight saturation probe below.

## 2. Time-to-first-429

Sequential writes against the write `rate()` limiter:

| metric | BEFORE | AFTER |
|---|---|---|
| refused at request # | 61 | 61 |
| ms to first refusal | 2238 | 2047 |
| status / code | 429 rate_limited | 429 rate_limited |
| Retry-After | `60` (blanket fallback) | `59` (precise seconds to window reset) |

In-flight saturation (16 trickled bodies pin the gauge, then probe):

| metric | BEFORE | AFTER |
|---|---|---|
| outcome | admitted — **no refusal path** (201) | **shed_503** |
| ms to decision | 576 | 672 |
| probe status | 201 | 503 |

This is the core fix demonstrated: saturation now refuses fast instead of
silently queueing.

## 3. Retry-storm no-rearm

Burn 60-write budget, send 50 refused retries, compare admit time vs control:

| metric | BEFORE | AFTER |
|---|---|---|
| window extended by storm | false | false |
| durable bucket rewritten on refusal | **true** (n 60→110 on 50 rejects) | **false** (0 rows changed) |
| admit-time delta (storm − control) | +519ms | −630ms (noise; no extension) |

BEFORE confirmed the write-amplification bug: every refused retry rewrote the
durable abuse-rate row. AFTER: refusals touch no state.

## Verdict

- Silent timeouts under fanout: 28.5% → 0%.
- Refusals now carry precise Retry-After (was blanket 60s).
- Saturation has a refusal path: 503 shed_load in <1s (was: none, silent queue).
- Retry storms no longer amplify writes or extend penalties.
- Residual: refusal latency under extreme saturation is still seconds (queue forms
  before the handler); accept-layer shedding is the next step.

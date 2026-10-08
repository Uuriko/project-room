# Trip-wire alert report — live load window (WAVE-300 Worker D)

Date: 2026-10-08. One-shot worker report for coordinator 10/10 (telemetry productionization).
Server commit: `bc2b675ab` ("server-side trip-wire gauges (5) + /api/health/tripwires").
All numbers below are measured, not estimated. Raw log: `.tmp/tripwire-load/load-log.json` (scratch, not committed).

## Setup

- Local server booted from this worktree: `RoomStore` on an isolated sqlite dir
  (`.tmp/tripwire-load/data-*`), `createRoomServer({ store })`, bound to
  `127.0.0.1:18443`. Never touched `room.trydemigod.com` or any remote.
- Room `commons` (from `initialRoom()`), owner credential via
  `store.issueAccessKey("commons", "owner")`, Bearer auth on all requests.
- `TMPDIR` pointed at the worktree `.tmp` per the brief. Wall time 252.9 s
  (~4.2 min); the 60 s trip-wire tick fired at boot and 4 more times during the run.
- Pilot limits in force: `eventsPerRoom = 1,000,000`, `projectionBytes = 4 MiB`.

## Load profile

| Phase | What | Result |
|---|---|---|
| Baseline | `GET /api/health/tripwires` + room counts | 2 room events, gauges recorded |
| Pre-flight | 1× `message.posted` | 201 |
| Pre-flight | 1× `message.reaction.set` | 422 — unknown command type; the valid type is `message.reaction_set` (underscore). Phase B used `message.posted` instead. |
| SSE | 3 streams opened on `/api/rooms/commons/stream` (per-credential cap is 3) | 3× 200, held open for the whole window; every posted event fanned out to all 3 |
| A — burst | 150× `POST /api/rooms/commons/commands` (`message.posted`, unique ids, concurrency 8, completed in seconds) | 32× 201, 118× 429 |
| B — steady | 100× `message.posted` at 1.2 s intervals (~50/min, under the 60/min write limit), 155 s | 69 ok, 31× 429 (room flood guard: refill 0.5/s < send rate 0.83/s) |
| C — timeout races | 200× raw TCP sockets: full valid POST then immediate `destroy()` without reading | 0 `timeout` outcomes recorded (see analysis) |
| C — malformed | 5× invalid-JSON bodies | 5× 429 — the write limiter (saturated by earlier phases) refused them **before** body parsing, so the JSON parser never saw them |
| Final | waited for a post-load 60 s tick, then `GET /api/health/tripwires` + room counts | 125 room events total |

The 118× 429 in phase A are a mix of room-flood-guard 429s (first 60 requests, which
passed the write limiter: 32 ok + 28 flood-429) and write-limiter 429s (requests past
60/min: ~90 refusals). Both return `code: "rate_limited"` with the message nested at
`body.error.message`, so a response-body classifier could not split them after the
fact; the penalty gauge itself is the authoritative count of write-limiter refusals.

## Before / after

| Gauge | Before (value / status) | After (value / status) | Δ |
|---|---|---|---|
| `event_budget_remaining_ratio` | 0.999998 / ok | 0.999875 / ok | −0.000123 over 123 events |
| `write_limiter_penalty_entries` | 0 / ok | 238 / **critical** | +238 |
| `event_loop_delay_ms_p99` | 511 / **critical** | 253886463 / **critical** | see unit analysis — values are nanoseconds, not ms |
| `projection_bytes_ratio` | 0.0001714 / ok | 0.0093968 / ok | +0.0092254 over 123 events |
| `commands_silent_timeout_ratio` | 0 / ok | 0 / ok | 0 timeouts across ~162 in-branch command requests + 200 destroy-races |

## Which trip-wires fired

- **FIRED — `write_limiter_penalty_entries` (warn ≥ 5, critical ≥ 20): 0 → 238, critical.**
  A 150-request burst in a few seconds is enough: the write-family limiter
  (`rate('write:<credentialHash>', 60)` = 60/min) refused ~90 of them, each refusal
  calling `recordWriteLimiterPenalty()`. Sustained over-limit traffic (phase C)
  added the rest. Entries live in a trailing 15-minute window and decay on the tick.
- **"Fired" but BROKEN — `event_loop_delay_ms_p99`: see findings.** It reported
  critical at baseline on an idle server and critical after load for the wrong reason.
- The other three gauges never left `ok`.

## Zero-room-event verification

Room event counts were read directly from the store (`SELECT COUNT(*) FROM events`)
immediately before and after the trip-wire reads:

- Baseline: 2 events before → 2 events after the two `GET /api/health/tripwires` reads. Added: **0**.
- Final: 125 events before → 125 events after. Added: **0**.

The endpoint emits zero room events, as designed. (The 123 events created during the
run are the load itself, not telemetry.)

## Verdict per gauge

- `event_budget_remaining_ratio` — **HEADROOM-MEASURED**. Δ = −1.0e-6 per event,
  exactly `1/eventsPerRoom`. Warn (< 0.2) would need ~800,000 events in a room;
  critical (< 0.1) ~900,000. Unreachable in any realistic pilot window; the gauge
  works but will effectively never fire at these limits.
- `write_limiter_penalty_entries` — **FIRES**. See above. The 60/min write-family
  budget is the binding constraint for any burst client; 5 refusals in 15 min is
  enough for warn, so this is the most sensitive trip-wire of the five.
- `event_loop_delay_ms_p99` — **FIRES (false positive at baseline; true verdict,
  wrong magnitude, after load)**. Findings for Worker B/C below — do not trust the
  current values for alerting.
- `projection_bytes_ratio` — **HEADROOM-MEASURED**. Δ ≈ +7.5e-5 per event
  (~315 bytes/event at this message size). Warn (> 0.7) needs ~9,300 events;
  critical (> 0.9) ~11,900. Healthy headroom.
- `commands_silent_timeout_ratio` — **HEADROOM-MEASURED** (ratio 0.0; the
  denominator moved, the numerator never did). 200 destroy-race probes produced
  zero `timeout` outcomes. Code-path analysis: `trackCommandOutcome(res)` attaches
  **after** `await body(req)` completes, and the handler then runs synchronously
  through `store.command()` to `record("ok"/"429"/…)`. A client that aborts
  before/during body parse never touches the counter (verified: `readText` rejects
  `400 aborted` pre-tracker), and a client that completes the body cannot interleave
  a close into the synchronous record path. The `timeout` outcome is therefore not
  a client-abort signal — it can only fire if the event loop stalls (or a future
  `await` lands) between tracker attach and `record()`. It is a handler-stall
  canary. Under a healthy local server it is effectively unreachable; that is
  expected, not a bug — but the gauge name/description oversells it.

## Findings for Worker B / Worker C (not fixed — out of my write scope)

1. **`event_loop_delay_ms_p99` has a ×1e6 unit error.** `collect()` stores
   `monitor.percentile(99)` raw, but `node:perf_hooks` `monitorEventLoopDelay`
   reports **nanoseconds** (verified empirically: idle min ≈ 20,086,784 ns ≈ the
   20 ms resolution; a 250 ms synchronous block registers max ≈ 336,330,751 ns).
   The gauge name says `_ms` and thresholds are 50/200 (ms). Fix: divide by 1e6.
2. **Empty-histogram false critical.** With zero samples recorded,
   `percentile(99)` returns the constant **511** (reproduced in isolation), and the
   boot tick samples exactly that (the synchronous store init blocks the loop, so
   no 20 ms fires occur before the first `collect()`). 511 > 200 → the gauge
   reports **critical on a freshly booted idle server**. Fix: skip the gauge
   (leave `unknown`/previous value) when the monitor has recorded no samples.
3. **Thresholds vs. measurement semantics.** The monitor measures inter-fire
   intervals with a floor ≈ resolution (20 ms); idle p99 ≈ 27–35 ms. After the
   unit fix, warn > 50 / critical > 200 ms remain meaningful, but note p99 over a
   60 s window (3,000 samples) is insensitive to isolated stalls — only sustained
   degradation (≥1% of samples) moves it.
4. After the unit fix, the load-window reading of 253,886,463 ns ≈ **254 ms**
   is a genuine critical (plausible on this shared VM under the burst + 200
   aborted sockets); the pre-fix classification reached the right verdict for the
   wrong reason.

## Notes / caveats

- Reaction probing: the command type is `message.reaction_set`, not
  `message.reaction.set` (server suggests the correction in the 422 message).
- My phase-A response classifier could not split flood-guard vs write-limiter
  429s (both `code: "rate_limited"`, message nested at `body.error.message`);
  the 238 penalty-gauge count is authoritative for write-limiter refusals.
- Event-loop numbers above are single-run observations on a shared VM; treat the
  254 ms post-load p99 as "a real stall happened", not a precise benchmark.

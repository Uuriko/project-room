# Trip-wire gauges (guild-11 slice docs)

Source: `server/tripwires.mjs` (registry), `telemetry/gauges.mjs` (contract view).
Load-bearing constraint: telemetry is cheap — ZERO room events, ZERO read-path
writes. Per-request work is limited to in-memory counter ops (penalty-box entry,
command-outcome recording). All expensive reads (room-store SQL, event-loop
histogram sampling) happen on the slow `collect()` tick (>= 60s).

## Registry shape

Each gauge: `{ name, value, warnAt, criticalAt, status, updatedAt }`.
Status enum: `ok | warn | critical | unknown`. `unknown` appears only when a
gauge never held a numeric value; every gauge starts at a documented neutral
default (0, 1, or 0) so reads are always numeric.

## The 5 gauges

| internal name | contract name | direction | warnAt | criticalAt | initial | unit |
|---|---|---|---|---|---|---|
| event_budget_remaining_ratio | event-budget-low | low | 0.2 | 0.1 | 1 | ratio |
| write_limiter_penalty_entries | write-limiter-penalty-box | high (inclusive) | 5 | 20 | 0 | count |
| event_loop_delay_ms_p99 | sse-event-loop-saturation | high | 50 | 200 | 0 | ms |
| projection_bytes_ratio | projection-size-growth | high | 0.7 | 0.9 | 0 | ratio |
| commands_silent_timeout_ratio | commands-silent-timeout-rate | high | 0.1 | 0.3 | 0 | ratio |

## Threshold semantics (gaugeStatus)

- Thresholds are STRICT by default: a value exactly AT warnAt/criticalAt has
  NOT tripped (e.g. event-loop p99 == 50ms reads "ok", == 200ms reads "warn").
- The penalty gauge is `inclusive: true`: warn at >= 5, critical at >= 20
  (the contract pins those boundaries).
- Non-numeric values (null, NaN, strings) read "unknown", never a fake "ok".

## Contract view (telemetry/gauges.mjs)

`gauges` is a LIVE view: each property access recomputes
`{ value, threshold, status }` from the singleton registry.
- `threshold` is the TRIP threshold (internal `criticalAt`) — the value at
  which status flips to "trip".
- Status mapping: internal "critical" -> contract "trip"; "warn" -> "warn";
  everything else ("ok", "unknown") -> "ok". No data yet reads as nominal.
- `server/http.mjs` imports the same singleton, so its hook points
  (write-limiter refusals, /commands outcomes, slow store tick) feed the exact
  registry the contract view reads.

## Pure helpers (unit-tested)

- `eventBudgetRemainingRatio(rows, eventsPerRoom)` — min remaining budget
  across rooms; empty store reads 1 (full); clamped at 0 past the limit.
- `projectionBytesRatio(rows, limit)` — max projection fraction; empty reads 0.
- `silentTimeoutRatio(outcomes)` — timeouts / total; empty reads 0.

## Windowed gauges

Penalty entries and command outcomes live in 15-minute rolling windows
(`PENALTY_WINDOW_MS`, `COMMAND_OUTCOME_WINDOW_MS`). `pruneWindows()` runs
on every record call and on the slow tick, so a quiet period decays the gauges
back to ok with no new events. Entries are non-decreasing ms timestamps.

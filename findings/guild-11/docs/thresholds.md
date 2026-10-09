# Alert thresholds (guild-11 slice docs)

Pinned by `tests/tripwires.test.mjs` and `telemetry/tripwire-contract.test.mjs`.
All thresholds are gauge-VALUE thresholds, evaluated by `gaugeStatus()`.

## ok -> warn -> critical ladder

| gauge (contract name) | warn when | critical when | inclusive? |
|---|---|---|---|
| event-budget-low | remaining ratio < 0.2 | remaining ratio < 0.1 | no |
| write-limiter-penalty-box | penalty entries >= 5 | penalty entries >= 20 | YES |
| sse-event-loop-saturation | p99 > 50ms | p99 > 200ms | no |
| projection-size-growth | ratio > 0.7 | ratio > 0.9 | no |
| commands-silent-timeout-rate | ratio > 0.1 | ratio > 0.3 | no |

## Boundary rules

- Exclusive (default): the value AT the threshold has NOT tripped.
  - event-loop p99 == 50ms -> ok; == 200ms -> warn.
  - timeout ratio == 0.1 -> ok; == 0.3 -> warn (2/11 ~ 0.18 -> warn, 4/13 ~ 0.31 -> critical).
  - budget ratio == 0.2 -> ok; == 0.1 -> warn.
  - projection ratio == 0.7 -> ok; == 0.9 -> warn.
- Inclusive (penalty gauge only): value AT the threshold HAS tripped.
  - 4 entries -> ok; 5 -> warn; 20 -> critical.

## Worked transitions (from tests)

- Event budget: sequence 500/1000 (0.5) -> ok; 850/1000 (0.15) -> warn;
  950/1000 (0.05) -> critical.
- Projection: 500/1000 -> ok; 800/1000 -> warn; 950/1000 -> critical.
- Silent timeouts: 1/10 -> ok; 2/11 -> warn; 4/13 -> critical.

## Decay

Windowed gauges decay without new events: after PENALTY_WINDOW_MS (15 min) of
quiet, the next collect() tick prunes expired entries and the gauge returns to
ok. No explicit reset call exists — decay is the reset.

## Endpoint

GET `/api/health/tripwires` returns `{ updatedAt, gauges: [...] }` with all
5 gauges (internal names). 200 + application/json.

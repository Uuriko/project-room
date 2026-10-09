# Telemetry extension: event-survival gauges + dashboard (WAVE-500 W16)

Spec for the WAVE-300 `telemetry-prod` lane (`wave300/telemetry-prod`).
**Nothing in this doc modifies the existing telemetry files** — all gauge
registry, dashboard, and baseline files live on that branch; this doc pins
the exact extension points, names, thresholds, card designs, and JSON
shapes so the extension lands consistently.

Load-bearing constraints (inherited from `server/tripwires.mjs`):
trip-wire checks emit **zero room events**, do **zero writes to any read
path**, and run **no expensive reads per request** — namespace counters,
rotation watermark scans, and event-loop sampling all happen on the slow
`collect()` tick (>= 60 s). The only new per-request work allowed is the
single in-memory counter op for compaction-sweep completion, exactly like
`recordWriteLimiterPenalty`.

Math source of truth: `server/event-survival-metrics.mjs` (this worktree,
`wave500/event-survival`). The helpers are pure — no IO, no store access,
no clock; caps are injected with defaults matching `PILOT_LIMITS`
(`server/store.mjs:427`): `eventsPerRoom = 1_000_000`, `projectionBytes =
4 * 1024 * 1024` (4 MiB, verified current after the G11 cap saga).

## 1. New gauges

Follow the existing registry contract: gauge shape
`{ name, value, warnAt, criticalAt, status }` where status is
`ok|warn|critical|unknown` internally and the contract view in
`telemetry/gauges.mjs` maps `critical → "trip"`, `warn → "warn"`,
`ok/unknown → "ok"`. `threshold` in the contract view is the trip edge
(internal `criticalAt`). Threshold edges are **strict** (a value exactly
at the edge has not tripped), per `gaugeStatus()` in
`server/tripwires.mjs`.

| # | Contract name (kebab, `telemetry/gauges.mjs`) | Internal name (`server/tripwires.mjs`) | Direction | warn edge (`warnAt`) | trip edge (`criticalAt`) | Neutral default | Value source |
|---|---|---|---|---|---|---|---|
| 6 | `namespace-budget-low` | `namespace_budget_remaining_ratio` | low | 0.25 | 0.1 | 1 | min `remainingRatio` across enabled namespaces, computed by `namespaceUsage()` on the slow tick |
| 7 | `compaction-ineffective` | `compaction_effectiveness_ratio` | low | 0.2 | 0.05 | 1 | last sweep's `bytesSavedRatio` from `compactionStats()`, set on sweep completion |
| 8 | `rotation-watermark-high` | `rotation_watermark_ratio` | high | 0.75 | 0.95 | 0 | max `watermarkRatio` across rooms from `rotationWatermark()`, computed on the slow tick |

### Exact `GAUGE_DEFS` additions (`server/tripwires.mjs`)

```js
{ name: "namespace_budget_remaining_ratio", direction: "low", warnAt: 0.25, criticalAt: 0.1,
  initialValue: 1, unit: "ratio",
  description: "Minimum remaining event-budget ratio across enabled namespaces (ceiling = floor + burst + maxBorrow). Worst namespace drives the gauge — same min-pattern as event_budget_remaining_ratio. Computed on the slow tick via namespaceUsage()." },
{ name: "compaction_effectiveness_ratio", direction: "low", warnAt: 0.2, criticalAt: 0.05,
  initialValue: 1, unit: "ratio",
  description: "Latest compaction/coalescing sweep's bytesSavedRatio (bytes saved / bytes before). Advisory: pairs with the budget gauge — budget burning while compaction saves nothing is the danger pattern. Set on sweep completion; the tick never decays it." },
{ name: "rotation_watermark_ratio", direction: "high", warnAt: 0.75, criticalAt: 0.95,
  initialValue: 0, unit: "ratio",
  description: "max(sequence / eventsPerRoom, projectionBytes / 4MiB) across rooms. 0.75 NOTICE, 0.85 WARN (rotation claimable), 0.95 FREEZE-PENDING, 1.0 EXHAUSTED — docs/wave500/ROOM-ROTATION-DESIGN.md §1. Computed on the slow tick via rotationWatermark()." },
```

### Exact `CONTRACT_VIEW` additions (`telemetry/gauges.mjs`)

```js
["namespace-budget-low", "namespace_budget_remaining_ratio"],
["compaction-ineffective", "compaction_effectiveness_ratio"],
["rotation-watermark-high", "rotation_watermark_ratio"],
```

### Exact `EXPECTED_GAUGES` additions (`telemetry/tripwire-contract.test.mjs`)

```js
"namespace-budget-low",      // per-namespace event budget exhaustion
"compaction-ineffective",    // compaction sweep saving almost nothing
"rotation-watermark-high",   // room approaching forced rotation/archive
```

### Threshold rationale (matches the design docs)

- **Namespace warn 0.25 / trip 0.1** — `docs/wave500/EVENT-BUDGET-DESIGN.md`
  §3 mandates per-namespace alerts at 50/25/10% remaining, with the 10%
  tripwire firing *before* the first 409 (`namespace_event_budget_low`).
  The 50% alert is dashboard-only (informational), not a trip-wire.
- **Compaction warn 0.2 / trip 0.05** — a sweep that saves <20% is worth
  a look; <5% means coalescing is doing nothing while events burn. Never
  a 4xx — it is advisory, unlike the budget tripwires.
- **Rotation warn 0.75 / trip 0.95** — `docs/wave500/ROOM-ROTATION-DESIGN.md`
  §1: NOTICE at 75% (owner banner), WARN at 85% (rotation claimable),
  FREEZE-PENDING at 95% ("rotation must finish now"), EXHAUSTED at 100%
  (today's silent death). warn at 0.75, trip at 0.95 — the dashboard phase
  banner covers the 85% WARN and 100% EXHAUSTED states.

### Hook points (collector wiring, telemetry-prod's job)

- `namespace_budget_remaining_ratio`: on the slow tick, read the
  per-namespace spent-since-enable counters + `eventBudgets` room config;
  value = `namespaceUsage(counters, budgets)` → min `remainingRatio`.
  Budgets disabled or no namespaces → gauge holds its neutral default 1.
- `compaction_effectiveness_ratio`: hook point in the coalescing sweep
  completion path (cf. W10 `server/event-coalesce.mjs`); one in-memory set
  of `compactionStats(before, after).bytesSavedRatio`. No tick decay —
  it is a last-observation gauge.
- `rotation_watermark_ratio`: on the slow tick, scan `rooms` for
  `(sequence, LENGTH(projection))` (two integers per room — the same scan
  the rotation-watch job already does); value = max
  `rotationWatermark(seq, bytes).watermarkRatio`.

## 2. Dashboard cards (`telemetry/ops-dashboard.html`)

**No changes required for the three new gauge cards.** `renderGauges()`
iterates `data.gauges` generically — the new gauges appear automatically
with their `warnAt`/`criticalAt` edges and status pills. That is the
primary dashboard integration.

New **"Event survival"** section cards, fed by the new
`GET /api/health/event-survival` endpoint (§4). All read-only; the
dashboard polls at the existing 30 s cadence, or the endpoint's own
`updatedAt` tick, whichever is slower.

1. **Namespace budgets card** — table, one row per metered namespace:
   columns `namespace | consumed / ceiling | remaining bar (colored by
   status) | borrowed | status pill`. Footer line: `unmetered:
   [rogue-board, …]` when non-empty (namespaces with events but no
   config — visible, never dropped). Sorted worst `remainingRatio` first.
2. **Compaction card** — last sweep: `bytesSaved / bytesBefore` as a
   percentage bar with warn (20%) and critical (5%) edges marked;
   sub-line `events: <eventsSaved> / <eventsBefore>`; caption
   "advisory — read together with the budget gauge".
3. **Rotation watermark card** — phase banner pill
   (`ok | notice | warn | freeze-pending | exhausted`, colored by phase)
   + `binding: events | projection` label + two thin bars (event ratio,
   projection ratio) with the 75/85/95/100 marks. At `warn` or above,
   the card links to the rotation claim flow.

Baseline comparison: the existing "Load baseline JSON…" matcher
compares `gauges[]` by name; extend it to compare
`eventSurvival.namespaces[]` by `namespace` (delta `remainingRatio`),
`eventSurvival.compaction` (`bytesSavedRatio` delta), and
`eventSurvival.rotation` (`phase` transition, e.g. `warn → freeze-pending`).

## 3. Baseline fields (`telemetry/capture-baseline.mjs`)

Add an `eventSurvival` block to the baseline record, populated from the
same two sources the dashboard uses (tripwires endpoint + the new
endpoint). Shape:

```json
{
  "capturedAt": "2026-10-08T19:40:00.000Z",
  "source": "http://127.0.0.1:8787/api/health/tripwires",
  "updatedAt": 1728423600000,
  "gauges": [ { "name": "namespace-budget-low", "value": 0.9, "warnAt": 0.25, "criticalAt": 0.1, "status": "ok", "updatedAt": 1728423600000 }, "..." ],
  "eventSurvival": {
    "namespaces": [
      { "namespace": "default", "consumed": 5000, "floor": 20000, "burst": 20000,
        "maxBorrow": 10000, "ceiling": 50000, "borrowed": 0,
        "remaining": 45000, "remainingRatio": 0.9, "status": "ok" }
    ],
    "unmetered": ["rogue-board"],
    "compaction": {
      "bytesBefore": 100000, "bytesAfter": 70000, "bytesSaved": 30000, "bytesSavedRatio": 0.3,
      "eventsBefore": 1000, "eventsAfter": 640, "eventsSaved": 360, "eventsSavedRatio": 0.36
    },
    "rotation": {
      "sequence": 950000, "projectionBytes": 1048576,
      "eventRatio": 0.95, "projectionRatio": 0.25,
      "watermarkRatio": 0.95, "binding": "events", "phase": "freeze-pending"
    }
  }
}
```

All four `eventSurvival` blocks are the verbatim return values of
`namespaceUsage()`, `compactionStats()`, and `rotationWatermark()` —
the helpers ARE the serialization contract, so baselines, the endpoint,
and the dashboard can never drift from each other.

## 4. JSON shapes

### `GET /api/health/tripwires` (unchanged shape, 5 → 8 gauges)

```json
{
  "updatedAt": 1728423600000,
  "gauges": [
    { "name": "event_budget_remaining_ratio", "value": 1, "warnAt": 0.2, "criticalAt": 0.1, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "write_limiter_penalty_entries", "value": 0, "warnAt": 5, "criticalAt": 20, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "event_loop_delay_ms_p99", "value": 0, "warnAt": 50, "criticalAt": 200, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "projection_bytes_ratio", "value": 0, "warnAt": 0.7, "criticalAt": 0.9, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "commands_silent_timeout_ratio", "value": 0, "warnAt": 0.1, "criticalAt": 0.3, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "namespace_budget_remaining_ratio", "value": 1, "warnAt": 0.25, "criticalAt": 0.1, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "compaction_effectiveness_ratio", "value": 1, "warnAt": 0.2, "criticalAt": 0.05, "status": "ok", "updatedAt": 1728423600000 },
    { "name": "rotation_watermark_ratio", "value": 0, "warnAt": 0.75, "criticalAt": 0.95, "status": "ok", "updatedAt": 1728423600000 }
  ]
}
```

### `GET /api/health/event-survival` (new; read-only; no auth change)

```json
{
  "updatedAt": 1728423600000,
  "enabled": true,
  "namespaces": [
    { "namespace": "default", "consumed": 5000, "floor": 20000, "burst": 20000,
      "maxBorrow": 10000, "ceiling": 50000, "borrowed": 0,
      "remaining": 45000, "remainingRatio": 0.9, "status": "ok" },
    { "namespace": "guild-load", "consumed": 30000, "floor": 20000, "burst": 20000,
      "maxBorrow": 10000, "ceiling": 50000, "borrowed": 10000,
      "remaining": 20000, "remainingRatio": 0.4, "status": "ok" }
  ],
  "unmetered": ["rogue-board"],
  "compaction": {
    "bytesBefore": 100000, "bytesAfter": 70000, "bytesSaved": 30000, "bytesSavedRatio": 0.3,
    "eventsBefore": 1000, "eventsAfter": 640, "eventsSaved": 360, "eventsSavedRatio": 0.36,
    "completedAt": 1728423590000
  },
  "rotation": {
    "sequence": 950000, "projectionBytes": 1048576,
    "eventRatio": 0.95, "projectionRatio": 0.25,
    "watermarkRatio": 0.95, "binding": "events", "phase": "freeze-pending"
  }
}
```

Notes:
- `compaction.completedAt` is stamped by the collector at sweep
  completion — the only timestamp in the whole surface, owned by the
  registry, never by the pure helper.
- `rotation` here describes the room that binds the gauge (worst
  watermark); multi-room deployments keep per-room rows in the dashboard
  table only, not in this endpoint.
- When `eventBudgets` is disabled: `"enabled": false`, `namespaces: []`,
  `unmetered: []`; the other blocks still report (rotation and
  compaction are not budget-gated features).

## 5. Status mapping summary

| Surface | ok | warn | trip |
|---|---|---|---|
| `server/tripwires.mjs` gauge | `ok` (incl. `unknown` neutral) | `warn` | `critical` |
| `telemetry/gauges.mjs` contract | `ok` | `warn` | `trip` |
| `namespaceUsage()` helper | `ok` | `warn` (< 0.25 remaining) | `critical` (< 0.10 remaining) |
| `rotationWatermark()` helper | `ok` | `notice`/`warn` (0.75–0.95) | `critical` mapping point at 0.95 (`freeze-pending`) — contract shows `trip`; the `exhausted` phase is 100% |
| Dashboard pills | green | amber | red |

# CI queue-depth telemetry emitter (FIX-22c)

CI is the swarm's de facto serializer: at 40 agents the board observed 443
queued runs with a 135-minute median wait, and an 868-run/2h burst broke the
queue outright. Nobody could see the queue depth programmatically — there was
no gauge and no alert before the ρ>1 knee, the point where arrival rate
exceeds service rate and queue wait starts diverging superlinearly.

This emitter closes the loop to the spend tap behind FIX-22: every 15 minutes
it samples the Actions queue (queued count, running count, p50 wait), appends
a `ci.queue_depth_sample` record to a local JSONL log, and evaluates a knee
detector. When the detector fires, the recorded series is the evidence that
justifies the runner-capacity decision. Code only: no spend, no infra, no
credentials, no writes to external systems.

## Schema

Record shape, `ci.queue_depth_sample` v1 (full field list in
[queue-depth-schema.json](queue-depth-schema.json)):

```json
{
  "type": "ci.queue_depth_sample",
  "id": "ciqd-20261008T194500Z-7f3a",
  "timestamp": "2026-10-08T19:45:00.000Z",
  "repo": "Uuriko/project-room",
  "interval_s": 900,
  "queued": 12,
  "running": 8,
  "p50_wait_s": 390,
  "max_wait_s": 1500,
  "knee": { "alert": false, "rho_hat": 0.62, "reason": "stable window" }
}
```

Why not the guild telemetry-bus schema: the bus (`finding-schema.json` on
branch `telemetry-bus`) is a *findings* bus — discrete falsifiable claims,
one record per claim, deduplicated by `id` for a dashboard. A 15-minute gauge
series is not a finding; posting one finding per sample would be 96
near-duplicate claims a day and breaks the bus's dedupe semantics. The series
below is raw material: when it matters, a human or agent distills one
`FINDING` ("queue depth diverging, ρ>1 confirmed over 2h window") out of it.
Schema divergence is documented here rather than invented twice.

## Running it (15-minute cadence)

```sh
# one sample now; appends to the log, prints KNEE ALERT to stderr on detection
node telemetry/ci-queue/run-sample.mjs --repo Uuriko/project-room

# scripted / offline source (fixtures, tests, backfill rehearsal)
node telemetry/ci-queue/run-sample.mjs --repo Uuriko/project-room \
  --source-fixture ./fixture.json --out ./samples.jsonl

# cron: every 15 minutes (exit code 2 = knee alert, wire it to a pager/room post)
*/15 * * * * cd /srv/project-room && node telemetry/ci-queue/run-sample.mjs >> telemetry/ci-queue/samples.jsonl
```

The live source shells out to the machine's existing `gh` auth
(`gh run list --status queued|in_progress`); it reads CI state and writes
nothing external. Every sample is exactly one JSONL line.

## Knee detector (ρ>1)

ρ = λ/μ (arrival rate / service rate). We cannot see λ directly, so the
detector watches its observable signature over a rolling window (default: last
8 samples ≈ 2h at the 15-minute cadence):

- **trend rule** — least-squares slope of `queued` over the window is
  positive with R² ≥ 0.6 and ≥ `min_slope_per_min` (default 0.05 queued/min),
  while the latest depth ≥ `min_depth` (default 10): the queue is growing
  unboundedly, the ρ>1 signature. Fires.
- **hard rule** — latest `queued` ≥ `hard_knee_depth` (default 100): a huge
  backlog is already past any knee worth waiting to trend. Fires.
- anything else (stable oscillation, draining, too little history) stays
  quiet and reports its reason.

Tune via `detectKnee(samples, { window, minSlopePerMin, minDepth, hardKneeDepth })`.

## Files

| File | What |
|---|---|
| `queue-depth-sampler.mjs` | Pure core: `sampleOnce`, `detectKnee`, `p50`, `writeSample`, `loadSamples`. No network, no env credentials. |
| `github-actions-source.mjs` | Live source: reads queued/in-progress runs via local `gh` CLI. |
| `run-sample.mjs` | CLI: sample → append → evaluate knee → print. Exit 2 on knee alert. |
| `validate-record.mjs` | Zero-dep validator against `queue-depth-schema.json`. |
| `queue-depth-schema.json` | Record schema, v1. |
| `README.md` | This file. |

Tests: `tests/ci-queue-sampler.test.js` (fail-first: diverging fires, stable and
draining stay quiet, schema validation, no-network/credential audit).

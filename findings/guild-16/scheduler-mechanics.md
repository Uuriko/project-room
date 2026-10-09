# Scheduler mechanics — server/jobs.mjs

Generated 2026-10-09T11:16:31.294Z.

## Two runtimes, one registry

- **Worker (Cloudflare Durable Object):** `scheduled()` cron `*/30 * * * *` is only a safety net — it re-arms a missing alarm, it does not poll. Per-job alarms are armed via `earliestFutureAlarm()`: the minimum next-due time across fast, enabled, worker-runnable jobs. An idle room wakes twice an hour.
- **Node:** `startNodeScheduler()` runs one unref'd `setInterval(tickMs=1000)`; each tick calls `runOnce()`, which asks every node-runnable job whether it is due. The immediate post-commit webhook kick (`setDispatchKick` → queueMicrotask → drainWebhookDeliveries, failures swallowed) still flushes just-committed deliveries; the timer is the retry backstop.

## At-most-once per tick, at-least-once across restarts

- `runOnce()` sets a `running` flag; a re-entrant call returns `[]` immediately — concurrent ticks cannot double-run a job (fuzz f4 proves this).
- `lastRan` is a per-process Map. A missed N cadences still runs the job exactly once per tick (no catch-up burst — fuzz f5).
- A past-due next time is pushed out by one cadence (`earliestFutureAlarm`, `jobNextDue` fallback) so a finished tick cannot schedule an immediate wake loop.
- Across process restarts lastRan is forgotten: a job due at boot runs once on the first tick. Documented at-least-once semantics across restarts.

## Failure handling

- Per-job try/catch in `runOnce`: throw → `lastRan` still advances (retry waits a full cadence — no hot loop, fuzz f7), `record()` bumps `consecutiveFailures` and sets `lastErrorAt`, one warn line. Success resets counters and sets `lastSuccessAt`.
- `jobEnabled` fail-closed: a throwing `enabled()` disables the job; `jobDisabledReason` falls back to "Not configured" (fuzz f12).
- `summaryFailed(result)` = `scanError || errors > 0` — anything else (including null/undefined results) counts as success for record-keeping.
- Slow jobs (`retention`, `integrity`) never arm per-job worker alarms; they ride the safety-net cron.

## Budgets and overrides

- Default `JOB_BUDGET_MS=5000`; per-job `budgetMs` override via `defineJob`; deadline passed as `ctx.deadline`.
- Env overrides: `GROWTH_WATCH_INTERVAL_MS`, `CHANNEL_DRAIN_INTERVAL_MS` parsed by `finiteInterval` — unset/empty → default; non-finite → TypeError caught → feature disabled with a warn (fail-closed, fuzz f8). `0`/negative → disabled.
- `tickMs <= 0` → `start()` is a no-op (scheduler constructed but never ticks); `stop()` idempotent.

## Health: GET /api/health/jobs

- Node: `jobHealth()` reports every registry job — name, runtime (node|worker-only), enabled, reason, periodSeconds, lastRunAt/lastSuccessAt/lastErrorAt, consecutiveFailures. Fresh boot with no runs is NOT stale (no top-level status grading).
- Worker: `readJobHealth()` via the DO (see cloudflare-cron-probes.md); `consecutiveFailures >= 1` flips status off "ok".

## Clock assumptions

- `now` is injectable (`() => Date.now()` default). Backward jumps do not re-run (lastRan in the future → not due); NaN clocks run nothing and do not wedge the scheduler (fuzz f6).

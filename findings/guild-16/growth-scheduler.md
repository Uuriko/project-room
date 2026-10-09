# growth-scheduler — src/growth-scheduler.js

Generated 2026-10-09T11:16:31.544Z.

## Purpose

Drives a growth watcher (Track C C12) on a fixed cadence. Each tick calls `watcher.tick()` inside its own try/catch — a throwing tick is logged and counted, never propagated. Triggered alert hits go to `onAlert`; the default logs one structured console line per hit (identifier-only privacy: no delivery channels, no message bodies).

- **Default cadence:** `300000ms` (5 min) — `DEFAULT_INTERVAL_MS`.
- **Default rules:** `deadWindowRule({eventTypes: ["message.sent"], ruleId: "growth:dead-chat", severity: "warn"})`, `activitySurgeRule({eventType: "member.joined", pctThreshold: 1.0, ruleId: "growth:join-surge", severity: "war})`.
  - dead-chat: warn when no `message.sent` for a whole tick window.
  - join-surge: warn on 100%+ member-joined surge vs previous window.
- **Purity:** pure apart from the C9/C12 modules, setInterval and console. No network, no storage, no I/O of its own.
- **Timer:** unref'd — the scheduler never keeps the process alive by itself.

## API

- `createScheduler({watcher, intervalMs, onAlert})` — throws TypeError on bad watcher (must expose tick()), non-finite intervalMs, or non-function onAlert.
- `start()` — no-op when already running (single timer) or when `intervalMs <= 0` (disabled).
- `stop()` — idempotent; `isRunning()`; `getTickCount()`; `getErrorCount()`; `getTimer()` (exposed for tests/operators, not the delivery contract).

## Fault containment (fuzz f10, f11)

- watcher.tick() throws → errorCount+1, warn line, tick NOT counted, loop continues.
- onAlert throws for one hit → caught per-hit, warn with ruleId, remaining hits still delivered.
- Malformed tick results (null, non-array `triggered`) → treated as zero hits, no crash.
- Double start keeps exactly one timer; stop-before-start is safe; start→stop→start re-arms.

## Wiring into the job registry

In `server/jobs.mjs` `startNodeScheduler`, the growth watcher is built only when `GROWTH_WATCH_INTERVAL_MS` parses to a positive finite number; otherwise growth stays disabled with a warn. The registry job `growth-watch` (runtimes: node only) calls `ctx.growthTick()`, which runs the watcher tick and delivers alerts via `defaultOnAlert`. An env interval override replaces the job cadence via the `overrides` map (visible in `jobHealth().periodSeconds`).

## Gotchas

- `intervalMs: 0` disables silently — intended, but a typo'd env var (`GROWTH_WATCH_INTERVAL_MS=""`) falls back to the 5-minute default rather than disabling; only explicit `0`/negative disables.
- Alert delivery is console-only by default; any real channel must be wired by the operator via `onAlert`.

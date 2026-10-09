# Job registry — server/jobs.mjs

Generated 2026-10-09T12:54:49.031Z from source. One registry drives both runtimes:
the Cloudflare Worker (Durable Object alarms) and the Node process (1s unref'd timer).

Constants: `JOB_BUDGET_MS`=5000, `MINUTE_MS`=60 * 1000, `HOUR_MS`=60 * MINUTE_MS, `DAY_MS`=24 * HOUR_MS, `SAFETY_NET_CRON`="*/30 * * * *", `SAFETY_NET_MS`=30 * MINUTE_MS, `ALARM_RETRY_MS`=MINUTE_MS, `JOBS`=Object.freeze([
  defineJob({
    name: "gmail-sync",
    cadenceMs: MINUTE_MS,
    runtimes: Object.freeze(["worker", "node"]),
    redactErrors: true,
    enabled: env => gmailOn(env),
    disabledReason: () => "Gmail is off",
    async run(store, ctx) {
      if (ctx.room?.syncGmailMailboxes) return ctx.room.syncGmailMailboxes().

| job | cadence | runtimes | slow | enabled gate | disabled reason |
|---|---|---|---|---|---|
| gmail-sync | MINUTE_MS (60 * 1000) | "worker", "node" | false | `gmailOn(env),` | Gmail is off |
| channel-drain | MINUTE_MS (60 * 1000) | "worker", "node" | false | `` | No channel update is waiting |
| webhook-dispatch | MINUTE_MS (60 * 1000) | "worker", "node" | false | `` | No webhook delivery is waiting |
| land-queue | MINUTE_MS (60 * 1000) | "worker", "node" | false | `` | No open pull request is waiting |
| claim-prs | MINUTE_MS (60 * 1000) | "worker", "node" | false | `` | No open pull request is waiting |
| retention | HOUR_MS (60 * MINUTE_MS) | "worker", "node" | true | `true,` | — |
| integrity | HOUR_MS (60 * MINUTE_MS) | "worker", "node" | true | `true,` | — |
| public-read-model | MINUTE_MS (60 * 1000) | "worker", "node" | false | `` | Public read model backfill is finished |
| room-backup | DAY_MS (24 * HOUR_MS) | "worker" | true | `backupConfigured(env),` | Neither ROOM_BACKUPS (R2) nor ROOM_BACKUPS_KV is configured |
| growth-watch | DEFAULT_INTERVAL_MS | "node" | false | `true,` | — |

## Per-job detail

### gmail-sync

- **Purpose:** Pull Gmail mailbox changes into the room. Runs only when ROOM_GMAIL_ENABLED=1 (currently shelved — stays 0).
- **Cadence:** MINUTE_MS (60 * 1000)
- **Runtimes:** "worker", "node"
- **Enabled gate:** `gmailOn(env),` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** Gmail is off
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### channel-drain

- **Purpose:** Drain queued Telegram/channel updates. Wakes only when pending_channel_updates is non-empty (or telegram configured).
- **Cadence:** MINUTE_MS (60 * 1000)
- **Runtimes:** "worker", "node"
- **Enabled gate:** `undefined` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** No channel update is waiting
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### webhook-dispatch

- **Purpose:** Deliver pending/failed agent webhook deliveries; immediate post-commit kick + 1s timer backstop. Dead-letters after max attempts.
- **Cadence:** MINUTE_MS (60 * 1000)
- **Runtimes:** "worker", "node"
- **Enabled gate:** `undefined` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** No webhook delivery is waiting
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### land-queue

- **Purpose:** Poll open PRs in the merge/land queue; backs off while rate-limited.
- **Cadence:** MINUTE_MS (60 * 1000)
- **Runtimes:** "worker", "node"
- **Enabled gate:** `undefined` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** No open pull request is waiting
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### claim-prs

- **Purpose:** Poll PRs linked to work claims; follow-up discovers unlinked PRs and links the deployed revision to settled claims. Follow-up failures are logged, never fail the poll.
- **Cadence:** MINUTE_MS (60 * 1000)
- **Runtimes:** "worker", "node"
- **Enabled gate:** `undefined` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** No open pull request is waiting
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### retention

- **Purpose:** Hourly table rotation: one RETENTION_TABLES entry per tick (runLiveStoreRetention) + prune webhook deliveries, OAuth providers, abuse buckets.
- **Cadence:** HOUR_MS (60 * MINUTE_MS) — SLOW: rides the safety-net cron (2 DO wakes/hour idle), never a per-job alarm
- **Runtimes:** "worker", "node"
- **Enabled gate:** `true,` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** —
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### integrity

- **Purpose:** Hourly room integrity verification; failures logged with oneLine() redaction, returns {errors:1} not throw.
- **Cadence:** HOUR_MS (60 * MINUTE_MS) — SLOW: rides the safety-net cron (2 DO wakes/hour idle), never a per-job alarm
- **Runtimes:** "worker", "node"
- **Enabled gate:** `true,` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** —
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### public-read-model

- **Purpose:** Backfill the public read model (20 rows/tick) until done; then stays disabled.
- **Cadence:** MINUTE_MS (60 * 1000)
- **Runtimes:** "worker", "node"
- **Enabled gate:** `undefined` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** Public read model backfill is finished
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### room-backup

- **Purpose:** Daily backup to ROOM_BACKUPS (R2) or ROOM_BACKUPS_KV. Worker-only: a Node process has neither binding.
- **Cadence:** DAY_MS (24 * HOUR_MS) — SLOW: rides the safety-net cron (2 DO wakes/hour idle), never a per-job alarm
- **Runtimes:** "worker" — single-runtime: Daily backup writes the ROOM_BACKUPS R2 bucket or the ROOM_BACKUPS_KV namespace. A Node process has neither binding.
- **Enabled gate:** `backupConfigured(env),` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** Neither ROOM_BACKUPS (R2) nor ROOM_BACKUPS_KV is configured
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

### growth-watch

- **Purpose:** Fixed-cadence growth watcher tick over the process-local collector. Node-only: the Worker does not host the collector.
- **Cadence:** DEFAULT_INTERVAL_MS
- **Runtimes:** "node" — single-runtime: Growth watch reads the process-local collector. The Worker does not host that collector.
- **Enabled gate:** `true,` — evaluated every tick/alarm; fail-closed on throw (jobEnabled catches → false).
- **Disabled reason:** —
- **Failure mode:** run() throws → caught per-job in runOnce: lastRan still advances (no hot retry loop), record() bumps consecutiveFailures, warn logged. Worker alarm path re-arms via ALARM_RETRY_MS.
- **Retry:** next due per cadenceMs or nextDueAt(); past-due times pushed out one cadence (no catch-up burst, no immediate loop).

## Gotchas

- `jobNextDue(job, null, …)` returns null for nextDueAt jobs when there is no store — the caller cannot see a due time, so the job is skipped (not run blindly), except the cadence fallback path.
- lastRan is in-memory per process; a restart forgets it (jobs re-run on first tick if due — at-least-once across restarts, at-most-once within a tick via the `running` guard).
- Budget: each run gets deadline = now + budgetMs (default 5000ms); jobs receive ctx.deadline and should respect it.

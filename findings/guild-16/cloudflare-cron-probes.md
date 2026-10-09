# Cloudflare cron proofs — cloudflare/jobs-alarm.check.mjs, scheduled-rpc.check.mjs

Generated 2026-10-09T11:16:31.612Z. These are workerd proofs (Miniflare + esbuild bundle of a local fixture), not unit tests: a stub that accepts every method cannot show an idle room staying asleep or a thrown alarm being re-armed.

## jobs-alarm.check.mjs — Durable Object alarm behavior

Fixture: `jobs-alarm.test-fixture.mjs` (JobsProbe DO, useSQLite). Probe routes: /scheduled, /probe/backfill, /probe/ensure, /probe/alarm-at, /probe/seed-due, /probe/seed-throw, /probe/delivery, /probe/alarm.

Tests:
- scheduled() leaves gmail and channel drain disabled when nothing is waiting
- an idle room arms no alarm inside a 10 minute window
- a webhook due in 30 seconds waits for the alarm
- a thrown alarm is rescheduled

What they prove:
- **Idle rooms stay asleep:** with nothing due, no alarm is armed inside a 10-minute window (the twice-an-hour safety net is the only wake).
- **Due webhooks wait for the alarm:** a delivery due in 30s arms the alarm within 1s of the due time; firing early leaves it pending; firing after the due time processes it to dead_letter (after max attempts).
- **Thrown alarms re-arm:** a throwing alarm returns 500 with `cron jobs failed: webhook-dispatch`, re-arms ~60s out (ALARM_RETRY_MS), and `consecutiveFailures` flips the job health off "ok".
- **Disabled-by-default:** gmail-sync and channel-drain report disabled (not stale) with a string reason when nothing is waiting; the health payload contains no `"configured":false` leak.

## scheduled-rpc.check.mjs — cron RPC reaches ProjectRoom

Fixture: `scheduled-rpc.test-fixture.mjs` (real ProjectRoom / RetentionTestRoom over the DO binding — workerd, not a stand-in, decides whether the method exists).

Tests:
- paused ProjectRoom cron methods run inside workerd, and an unknown method does not
- unpaused retention RPC applies one table per tick and rolls that table back on failure

What they prove:
- **Paused room:** all 7 CRON_METHODS (syncGmailMailboxes, drainChannelBacklog, drainWebhookDeliveries, refreshLandQueue, refreshClaimPullRequests, planRetention, backfillPublicReadModel) run inside workerd while paused with dry-run/skip semantics; an unknown method (`notARealCronMethod`) is rejected with the receiver's "does not implement" message — the RPC boundary is real.
- **Retention boundary:** one table per tick (web_fetch_log then web_research_log); a failing table's deletes roll back (counts unchanged); recovery proceeds to the next table; a fully-clean run deletes 0. Dry-run mode (`ROOM_RETENTION_ALLOW_DELETION=0`) deletes nothing.

## Gotchas

- Both checks bundle with esbuild and boot Miniflare per test — slow (~1-2 min each); they are the heavyweight leg of the slice's suite.
- The fixtures are test doubles for the *probe surface*, not the job logic: mutating the fixture must be caught by the check (mutation m9/m10 proves sensitivity per-behavior).
- `miniflare` + `esbuild` must resolve from the repo's node_modules; the checks do not run without install.

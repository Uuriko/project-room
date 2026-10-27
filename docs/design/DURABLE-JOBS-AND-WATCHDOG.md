# Durable jobs and watchdog

Jobs for the hosted room (`room.trydemigod.com`) run inside one SQLite Durable Object, `ProjectRoom`, named `invite-only-pilot`. On 24 October 2026 the hourly and daily work stalled around 20:00 because one alarm ran the due set past the CPU limit and the reset dropped job records that had not been committed. [#4581](https://github.com/Uuriko/project-room/pull/4581) persists each outcome before the next job and gives every slow job its own RPC. [#4582](https://github.com/Uuriko/project-room/pull/4582) caps automatic projection relief at 500 replayed events. Those fixes stay. They do not stop one alarm from owning every due fast job, and they do not notice an object whose alarm was lost when the platform restarted it.

A per-room object stack ([#4595](https://github.com/Uuriko/project-room/pull/4595), [#4596](https://github.com/Uuriko/project-room/pull/4596), [#4606](https://github.com/Uuriko/project-room/pull/4606) through [#4610](https://github.com/Uuriko/project-room/pull/4610), flag `ROOM_PER_ROOM_OBJECTS`, runbook `docs/design/ROOM-SHARD-CUTOVER.md` on that branch) is green and unmerged. This plan does not stack on it. The queue, the watchdog, and the history census run on the pilot object. `events` is already keyed by room, and that stack classifies `events` as a room table, so the same census SQL works on a later room object without a second writer.

The largest room's projection is about 3.76 MB against `PILOT_LIMITS.projectionBytes` (4 MiB) in `server/store.mjs`. Workerd also refuses an oversized SQLite value with `SQLITE_TOOBIG` (`cloudflare/storage.mjs`). Shrinking that projection is a separate change (`server/store-relief.mjs`, `server/operator-archive.mjs`, the normalized message window in [NORMALIZED-MESSAGE-SLICE.md](../NORMALIZED-MESSAGE-SLICE.md)). This plan does not archive messages, raise the cap, or edit the relief job.

Nothing here deploys, copies production, or sets a flag. Each flag is off unless the variable is exactly `1`. Unset is off. Rollback is unsetting the flag. New tables are replay-skipped, same as `abuse_rate_buckets`, so a backup taken while a flag is on still restores the room.

## What the code does today

`server/jobs.mjs` is the registry. Fast worker jobs run from `ProjectRoom.alarm`. Slow jobs (`retention`, `integrity`, `room-backup`, `store-growth`) run from `scheduled` in `cloudflare/room.mjs`, one `runSlowJob` RPC each. The cron is `*/30 * * * *` (`SAFETY_NET_CRON`). It cannot ask "is anything due?" without waking the object, so `ensureJobAlarm` both runs due fast jobs and calls `setAlarm`. `earliestFutureAlarm` ignores slow jobs and pushes an already-due fast job out by one cadence so a finished tick does not tight-loop.

`setAlarm` replaces the only alarm on the object. Heartbeats live in Durable Object storage at `cron:job-heartbeats:v1` (`cloudflare/job-heartbeat.mjs`). `GET /api/health/jobs` reads them from the room object. If that object is dead, the route is a 503 `unavailable` and says nothing about the last good tick.

The room's durable history is `events` (`room_id`, `sequence`, `id`, `body`) plus the normalized `messages` table. `rooms.projection` is a derived JSON blob. Writes fail with 409 `pilot_limit` when that blob would pass 4 MiB. Event rows are not under that cap. Clients that only read the projection cannot see that.

## Patterns

These are the Standard Agents alarm rules, mapped onto this worker.

1. A request enqueues work. It does not run the job. `scheduled` and `ensureJobAlarm` are requests. `waitUntil` is about 30 seconds and dies with the request. The alarm runs the work.
2. The queue is a SQLite table, because the object has one alarm. Each alarm claims one due row, checkpoints, runs that one job inside the existing `JOB_BUDGET_MS` (5 seconds, cooperative), then `setAlarm` for whatever is next. A kill cannot drop the rows still queued.
3. A second Durable Object, `JobWatchdog`, stores progress heartbeats. Its own alarm re-arms `invite-only-pilot` when progress stops and the subject's alarm is due or missing. The 30-minute cron remains only as the backstop that re-arms the queue and the watchdog. It stops calling `runSlowJob` once the queue flag is on.
4. History reads page `events`. A census stores counts, not a second copy of the projection. The 4 MiB cap continues to apply to `rooms.projection` only.
5. `GET /api/health/jobs` prefers the watchdog's last snapshot, so a dead room object does not erase the last receipt. Receipts are job name, time, ok, and attempt. They are not room bodies.

## Non-goals

- No change to job cadence, `JOBS`, store relief, or the message projection window.
- No per-room job fan-out. The watchdog reboots only `invite-only-pilot`. A room shard name is not a `getByName` target in this work.
- No public route that returns event bodies. The census summary is counts.
- No production flag, deploy, or backup restore drill.

## Phase 1 — durable alarm queue

Flag: `ROOM_DURABLE_ALARM_QUEUE`. Module: `server/durable-alarm-queue.mjs`, driven by `server/durable-alarm-turn.mjs`. `ProjectRoom.alarm` and `ensureJobAlarm` keep today's path when the flag is off.

### Data model

Table `durable_alarm_queue`, created on first use, not in the RoomStore schema version and not behind the writer fence. Older code has no path to it.

| Column | Meaning |
| --- | --- |
| `id` | Integer primary key. |
| `dedupe_key` | Unique. Jobs use `job:<name>:<slot>` where `slot` is `floor(now / cadenceMs)`. |
| `kind` | `fast-job` or `slow-job`. A later phase may enqueue `history-census`. |
| `payload` | JSON, at most 2000 characters. A job payload is `{ "name": "<job>" }` only. |
| `run_at` | UTC milliseconds. Claim requires `run_at <= now`. |
| `status` | `queued`, `running`, or `done`. |
| `attempt` | Incremented when the row is claimed. |
| `cursor_json` | `{ "phase": "started" \| "finished" \| "poisoned" }`. |
| `lease_until` | Set while `running`. |
| `created_at`, `updated_at` | UTC milliseconds. |

Index `(status, run_at, id)`.

Constants: lease 20 seconds (`DURABLE_ALARM_LEASE_MS`), retry 60 seconds (`DURABLE_ALARM_RETRY_MS`, same spacing as `ALARM_RETRY_MS`), slice gap 25 milliseconds (`DURABLE_ALARM_SLICE_GAP_MS`), done-row retention 24 hours pruned 50 rows at a time, max attempts 8 (`DURABLE_ALARM_MAX_ATTEMPTS`).

The table is listed in `REPLAY_SKIPPED_TABLES` (`server/room-export.mjs`). Replay reports the rows and does not load them. A restored object starts with an empty queue; the next cron enqueues whatever is due. The rows are operational state, not room history.

### Alarm turn

`ensureJobAlarm({ includeSlow: true })` from `scheduled`, when the flag is on, enqueues due jobs and arms. It does not call `runJob`. `scheduled` then returns. It does not call `runSlowJob`. Fast jobs are enqueued when they are due; slow jobs are enqueued only from that cron entry, which matches today's split (slow work is not on the fast cadence).

`alarm` enqueues newly due fast jobs, then `runDurableAlarmSlice` claims one row:

1. Recover `running` rows whose lease has expired. The cursor is kept. `attempt` is not reset.
2. Claim the oldest queued row with `run_at <= now` in one `UPDATE ... RETURNING`.
3. If `cursor.phase` is `finished`, mark `done` and do not run the job. That is a death after the work was committed and before `done` was written.
4. If `attempt` is greater than 8, mark `done` with phase `poisoned` and do not run. One bad row cannot spin forever.
5. Checkpoint `started` and refresh the lease, before the job.
6. Run that one job through the existing `#runDueJobs({ onlyJob })`, which already commits the heartbeat before it returns.
7. If the outcome is not ok, set the row back to `queued` at `now + 60s` and keep the cursor. The alarm handler still throws so the cron failure stays visible.
8. Checkpoint `finished`, then mark `done`.

The next alarm is the earlier of `nextDurableAlarmAt` and `earliestFutureAlarm`. A time that is already due becomes `now + 25ms`, so the platform can take a request between slices. `setAlarm` still replaces a later alarm and leaves an earlier one alone, same rule as `#armJobAlarm`.

### Failure modes

| Failure | What is durable | What happens next |
| --- | --- | --- |
| Job throws, or returns `ok: false` | The row, and any heartbeat `#runDueJobs` committed | Row is queued at `now + 60s`. Alarm throws. Attempt climbs. After 8 claims the row is poisoned. |
| Object dies after `started` and before `finished` | The row stays `running` with the cursor | Lease expires. The next slice runs the job again. Jobs already tolerate a repeated tick; this is the same retry the cron uses today. |
| Object dies after `finished` and before `done` | Cursor says the work was committed | The next slice marks `done` and does not run the job again. |
| Object dies before `setAlarm` | Queue rows | No alarm remains. The 30-minute cron enqueues and arms again. Between crons, Phase 2's watchdog calls `rebootAlarm`, which only `setAlarm`s. It does not run the job inside the watchdog's request. |
| Two crons enqueue the same slot | Unique `dedupe_key` | The second insert is a no-op while the row is `queued` or `running`. A `done` row for that slot is not reopened. |
| Payload will not parse, or the kind is unknown | The row | Treated as a failed attempt, then poisoned. |
| Flag turned off with rows left behind | Rows sit unused | `alarm` uses the old batch path and never reads the table. |

A job that ignores `JOB_BUDGET_MS` can still hit the 30-second production CPU limit. The queue does not make that job smaller. It keeps the other jobs as rows. Relief stays on the [#4582](https://github.com/Uuriko/project-room/pull/4582) budget.

### Tests

`tests/durable-alarm-queue.test.js` uses `node:sqlite`, not a stub that accepts every call.

- Three due rows: one slice runs one, and the arm time is due now.
- Death after `started`: the following slice, past the lease, runs the job once and completes it.
- Death after `finished`: the following slice does not run the job.
- A thrown job is still queued, waits out the retry, then runs.
- The ninth claim of a job that always throws is poisoned and not run.
- A second enqueue of the same dedupe key does not add a row.
- `runDurableAlarmTurn` with `drain: false` does not call `runJob`. With `drain: true` it calls `runJob` at most once.
- On a real `RoomStore`, creating the table does not bump the schema version.
- Replay of an export that contains a `durable_alarm_queue` line reports it skipped.
- `scheduled` with the flag set calls `ensureJobAlarm` and does not call `runSlowJob`. With the flag unset, the four slow RPCs still run.

### Metrics

One JSON log line per drained slice: `event: "room.alarm_queue"`, `recovered`, `ran`, `kind`, `attempt`. No payload and no error text.

## Phase 2 — watchdog

Flag: `ROOM_JOB_WATCHDOG`. Class `JobWatchdog` in `cloudflare/job-watchdog.mjs`, logic in `server/job-watchdog-store.mjs`. Binding `JOB_WATCHDOG`. Migration tag `job-watchdog-v1` with `new_sqlite_classes: ["JobWatchdog"]`, appended after `room-sqlite-v1`. Top-level and `env.staging` migrations both gain the tag. `env.production` and `env.staging` gain the binding with no `script_name`. The entry worker's binding uses `script_name: "project-room"`, same as `ROOM`, so the entry script does not create a second watchdog. Staging does not point at the production object.

The watchdog database is not a RoomStore. It uses `ctx.storage.sql` directly. `DurableDatabase` refuses a database that has no writer permit, so it is the wrong wrapper here.

### Data model

Table `watchdog_subjects`, one row per subject. This phase accepts only `invite-only-pilot`.

| Column | Meaning |
| --- | --- |
| `object_name` | Primary key. |
| `progress_at` | Last heartbeat, UTC milliseconds. |
| `alarm_at` | The subject's alarm time, or null. |
| `reboot_count`, `last_reboot_at` | Reboots this object has been given. |
| `jobs_json` | The last `jobHealthView` snapshot, capped at 16,000 characters. A snapshot that contains `recordId` is stored as `{}`. |
| `receipts_json` | The last 20 `{ job, at, ok, attempt }` objects. |
| `history_json` | Phase 3 counts, or `{}`. |

Constants: stall 60 seconds (`WATCHDOG_STALL_MS`), watchdog alarm period 30 seconds (`WATCHDOG_PERIOD_MS`), at most 5 reboots per watchdog alarm (`WATCHDOG_REBOOT_BATCH`). A subject is not rebooted again until one stall period after `last_reboot_at`.

### Heartbeat and reboot

The room beats at the end of `ensureJobAlarm` and at the end of the durable alarm. The beat is the public job-health view, the current alarm time, an optional receipt for the slice that just finished, and the history summary when Phase 3 is on. A beat that throws is logged and does not fail the job. The job has already committed.

The watchdog alarm selects subjects whose `progress_at` is older than the stall and whose `alarm_at` is null or already due, and that were not rebooted during this stall window. An idle room with an alarm in the future is not rebooted. `rebootAlarm` on `ProjectRoom` only calls `setAlarm(now + 25ms)`. The subject's own alarm runs the work.

`scheduled` calls `ensureArmed` on the watchdog whenever the watchdog flag is on. That call is the cron that remains after the queue flag stops `runSlowJob`. One short RPC replaces a sweep of every job. If the watchdog itself dies mid-alarm, the next cron re-arms it. The watchdog does not watch itself with a third object.

Enable the watchdog before the queue in production. The queue flag is what stops inline slow jobs. Without the watchdog, a lost alarm waits for the next 30-minute cron. The code allows the queue flag alone so tests can run it; production should turn the watchdog on first and see heartbeats before enabling the queue.

### Failure modes

| Failure | Result |
| --- | --- |
| Room dies, alarm time already passed, no beat for 60 seconds | Watchdog calls `rebootAlarm`. The subject's next alarm recovers or runs the queue. |
| Room is idle, alarm in the future | No reboot. |
| Beat cannot reach the watchdog | Jobs still run. The next successful beat fills the gap. Health falls through to the room object while the watchdog has no snapshot. |
| Watchdog dies | Cron `ensureArmed` sets its alarm again. Stored rows are in its SQLite and survive the restart. |
| Flag off | No beats, no reboot, health reads the room object, cron runs the old slow RPCs when the queue flag is also off. |
| `ROOM_JOB_WATCHDOG=1` but the binding is missing | Treated as off. |

### Tests

`tests/job-watchdog.test.js`.

- A fresh beat is not a reboot. After the stall, with the alarm due, `planWatchdogReboots` returns `invite-only-pilot`.
- `markRebooted` suppresses another reboot until the stall passes again.
- A new beat clears that. A future `alarm_at` is not a reboot even if progress is old.
- A subject name other than `invite-only-pilot` is rejected.
- Receipts stop at 20. A snapshot containing `recordId` is dropped.
- Health from the stored snapshot stays readable when no new beat arrives, and `stalled` becomes true past the stall. Status moves from `ok` to `stale`.
- Combined with Phase 1: a row left in `started` by a dead slice is rebooted by the plan, then the next slice past the lease runs it once.
- `rebootAlarm` is a real method on `ProjectRoom`. The RPC contract test resolves `beat`, `ensureArmed`, and `readHealth` on `JobWatchdog`, and `rebootAlarm` on `ProjectRoom`. A stub that answers every method still fails that test.

### Metrics

`event: "room.watchdog"`, `rebooted`, `stalled`. Counts only.

## Phase 3 — per-room SQLite history

Flag: `ROOM_SQLITE_HISTORY`. Module: `server/room-history.mjs`.

The projection cap is a limit on one column. `events.body` is already one row per event. This phase does not move bytes out of the projection and does not call `relieveProjectionsIncrementally` or `operatorArchive`. It makes the event log the history a caller can page, and it records the size so the cap is visible as a property of the projection rather than of the room.

### Data model

Two tables, created on first use, replay-skipped, not writer-fenced:

- `room_history_cursor` — one row, `after_room_id`. The census walks `rooms.id` in order, one room per turn, then wraps to `''`.
- `room_history_census` — `room_id`, `events`, `history_bytes` (`SUM(LENGTH(body))`), `projection_bytes` (`LENGTH` of `rooms.projection`), `through_sequence`.

`pageRoomHistory(db, roomId, { after, limit })` reads `sequence`, `id`, `json_extract(body, '$.type')`, and `LENGTH(body)` from `events`. Limit is clamped to 1..50. It does not read `rooms.projection` and it does not return the body. Room ids are checked against the existing safe id shape before the query; the id is a bound parameter either way.

`historyCensusSummary` returns only numbers: `rooms`, `events`, `historyBytes`, `largestProjectionBytes`, `roomsAtCap` (projection length at or above `PILOT_LIMITS.projectionBytes`). No room id.

When the queue flag is also on, the cron enqueues one `history-census` row (`dedupe_key` `history-census`, reopened when `done`) and a slice runs one room. When only the history flag is on, `scheduled` runs that one-room refresh itself. Either way the work is one room, not a scan of every body in the request that served a page.

### Failure modes

| Failure | Result |
| --- | --- |
| Refresh dies after the census upsert and before the cursor moves | The next turn repeats that room. The upsert is idempotent. |
| Projection is at the cap | Writes still return 409 `pilot_limit`. The census shows `roomsAtCap` and a `historyBytes` that can be larger than the projection. Paging still reads `events`. |
| Flag off | Tables are not required. No census, no extra cron work. |
| Backup replay | Census and cursor rows are skipped. The next refresh rebuilds them from `events`. |

### Tests

`tests/room-history-census.test.js`.

- A room whose projection is small and whose event bodies sum to more than 4 MiB: the summary's `historyBytes` is past the cap, `largestProjectionBytes` is under it, and a page of two rows does not load the projection column.
- The cursor advances one room per call and wraps.
- A `RoomStore` accepts the tables without a schema bump.
- Replay skips `room_history_census` and `room_history_cursor`.
- A watchdog beat that is handed a summary plus a room id stores the numbers and not the id.

### Metrics

`event: "room.history_census"`, `scanned`, `historyBytes`, `roomsAtCap`. No room id.

## Phase 4 — health and receipts from the watchdog

This is the read side of Phase 2, plus the history counts from Phase 3. It has no flag of its own. It is active only while `ROOM_JOB_WATCHDOG` is on.

`GET /api/health/jobs` calls `JobWatchdog.readHealth` first. The view is the stored `jobHealthView` snapshot (same grader the room uses, including disabled and required jobs as of that beat) plus:

```json
{
  "source": "watchdog",
  "watchdog": {
    "progressAt": "<iso>",
    "stalled": false,
    "rebootCount": 0,
    "receipts": [{ "job": "integrity", "at": 0, "ok": true, "attempt": 1 }],
    "history": { "rooms": 0, "events": 0, "historyBytes": 0, "largestProjectionBytes": 0, "roomsAtCap": 0 }
  }
}
```

`jobHealthResponse` already maps `ok` and `degraded` to 200 and everything else to 503. A stalled snapshot forces status `stale` even when the last beat said `ok`, and non-disabled jobs are marked stale. Receipts do not include error strings. History is omitted until Phase 3 has stored a summary; the field is then the numbers above, or null.

If the watchdog has never stored a beat, or the RPC throws, the route reads the room object as it does today. Turning the flag on cannot by itself turn health into `unavailable`.

Operator reading of the room object heartbeat stays. The watchdog is an extra copy of the public view, not a second grader with different rules. `recordId` never crosses into `jobs_json`.

### Tests

Covered with Phase 2 and Phase 3: stale override, receipt cap, history numbers without a room id, and the fall-through when the watchdog snapshot is missing. The flag-off path is the existing `/api/health/jobs` behavior; this plan does not replace those tests.

## Rollout and rollback

Deploy the worker with the flags unset. That registers `JobWatchdog` (the migration tag stays once Cloudflare has applied it; rollback does not delete the class). No request addresses it while the flags are unset.

1. Set `ROOM_JOB_WATCHDOG=1`. Confirm `GET /api/health/jobs` still returns 200 and, after one cron, `"source": "watchdog"` with receipts moving. Cron still runs slow jobs.
2. Set `ROOM_DURABLE_ALARM_QUEUE=1`. Confirm the next cron does not run four slow RPCs inline, `room.alarm_queue` lines show one `ran` per alarm, and `/api/health/jobs` job times keep moving. Slow jobs may take several alarms.
3. Set `ROOM_SQLITE_HISTORY=1`. Confirm `room.history_census` lines and `watchdog.history.historyBytes`. Confirm a write to the large room still returns 409 at the projection cap. Do not expect this flag to shrink the projection.

Rollback, in any order: set the flag back to unset (or anything other than `1`). The next isolate uses the old alarm and the old health read. Queue and census rows can stay. They are not read while the flag is off, and they are not restored into a rebuilt database.

Do not delete pilot rows. Do not point the watchdog at `ROOM_SHARD`. Do not set `ROOM_PER_ROOM_OBJECTS` from this work.

## Shard follow-up

When the room-shard branch lands, add `durable_alarm_queue`, `room_history_census`, and `room_history_cursor` to its skipped set if that set is not already `REPLAY_SKIPPED_TABLES`. They are pilot-wide operational tables. Copying them into a room object would put another room's queue on that object. Job fan-out per room is a later design: the watchdog's subject allowlist would have to grow, and reboot would use the room binding rather than `ROOM.getByName` of an arbitrary id.

## Invariants

[INVARIANTS.md](../INVARIANTS.md) still holds. A retried slice can run a job twice if the object dies after side effects and before the `finished` checkpoint. That matches today's cron retry. The `finished` checkpoint is what stops a retry from running work that already committed its heartbeat. Failed jobs do not delete queue rows. Reopening the room shows the committed heartbeat, and the watchdog shows the last beat even when the room object does not answer.

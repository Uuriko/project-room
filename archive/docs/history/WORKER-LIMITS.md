# Worker CPU limit and cold start

`cloudflare/wrangler.jsonc` sets `"limits": { "cpu_ms": 1000 }` and
`"observability": { "enabled": true, "head_sampling_rate": 1 }` (PR #141,
merged 2026-09-14; before it the cap was 50 ms and Workers Logs were off):
every Worker invocation, including the Durable Object's first request after
an isolate restart, has 1000 ms of CPU. The re-audit of 2026-09-14 (M5) found
the earlier 50 ms number unmeasured. `scripts/measure-cold-start.mjs` measures
the phases that first request pays; this page records the result so the cap
was decided against a number, and so a later change can be too. The
`limits` key is honoured only on the Paid plan's Standard usage model
(`cloudflare/README.md` "Runtime limits and logs").

## How to measure

One script, two subcommands (PR #160's per-phase measurement and PR #141's
constructor-against-a-filled-log measurement were folded into it; `--json`
works for both):

```sh
node scripts/measure-cold-start.mjs                       # phases: 3 runs, table
node scripts/measure-cold-start.mjs phases 5 --json       # phases: 5 runs, machine-readable
node scripts/measure-cold-start.mjs --no-miniflare        # phases: Node rows only
node scripts/measure-cold-start.mjs constructor           # 10,000 events, 5 cold constructions
node scripts/measure-cold-start.mjs constructor 2000 3 --help-history --json
```

`phases` (the default) answers "what does the first request pay on an empty
workspace?"; `constructor` answers "how does the store constructor grow with
the event log?".

Node rows come from fresh child processes: import of `server/store.mjs` and
`server/http.mjs`, a fresh store (`RoomStore` constructor plus `initialize`),
`listen` plus the first `GET /api/health`, the first authenticated room
snapshot, and reopening the existing database (the constructor path a
restarted object takes: schema verification, provenance repair, invitation
and help-history audits). CPU is `process.cpuUsage()` user plus system; wall
is elapsed time. Both are medians over the runs.

miniflare rows run the real `cloudflare/room.mjs` entry in workerd when
`cloudflare/node_modules` has miniflare and esbuild (`pnpm install
--frozen-lockfile --ignore-scripts` in `cloudflare/`); otherwise the script
says so and prints the Node rows only. workerd exposes no CPU counter, so
those rows are wall time, and `await mf.ready` runs before the first request
so the cold row is isolate creation, module evaluation and the object
constructor, not the workerd process start. The measurement bundle adds one
provisioning route to a subclass of `ProjectRoom`; it is built in memory and
is not a deployment artifact.

`constructor [events=10000] [runs=5] [--help-history] [--json]` builds one
database holding `events` audit rows (`message.posted`, capped at the
10,000-event pilot limit) with the real server modules, then times `runs`
cold `RoomStore` constructions of it: schema verification, projection
provenance repair, invitation audit and work-help history audit, the work a
restarted Durable Object does before its first answer. It reports the build
time and min / median / max wall and CPU of the constructor with every
sample. `--help-history` also opens one help invitation so the help audit
replays every event instead of taking its no-help fast path. The 10,000-event
build itself runs every command through the store and takes a few minutes;
the constructor samples are the measurement.

## Measured on 2026-09-14

Empty pilot workspace (`initialRoom()`: one room, one owner, two events),
median of 5 runs, Node v24.21.0, miniflare 4.20260730.0, Linux container
(`npm run check` host, not the Cloudflare edge):

| Runtime | Phase | CPU ms | Wall ms |
|---|---|---|---|
| Node | import `server/store.mjs` + `server/http.mjs` | 93.4 | 72.0 |
| Node | fresh store: constructor + `initialize` | 25.2 | 28.1 |
| Node | `listen` + first `GET /api/health` | 37.9 | 35.1 |
| Node | first authenticated `GET /api/rooms/commons` | 8.2 | 6.0 |
| Node | reopen existing store (constructor only) | 17.1 | 8.9 |
| miniflare | cold object, empty storage: first `GET /api/health` (isolate + modules + constructor + schema) | n/a | 42.7 |
| miniflare | warm `GET /api/health` | n/a | 4.0 |
| miniflare | cold object, existing store: first `GET /api/health` (reopen + verify) | n/a | 29.2 |
| miniflare | first authenticated `GET /api/rooms/commons` | n/a | 7.6 |
| miniflare | warm authenticated `GET /api/rooms/commons` | n/a | 4.3 |

Reading the table against the earlier 50 ms cap (the measurement that
justified 1000 ms):

- Module evaluation (about 93 ms CPU under Node) is charged to Worker startup,
  which has its own 400 ms limit, not to `cpu_ms`. It is the largest phase and
  the reason `import` is reported separately.
- The first request on a restarted object pays the store constructor (17 ms
  CPU on an empty database under Node; 29 ms wall in workerd including
  isolate work) plus the request itself (8 to 38 ms CPU). On an empty
  workspace that sum sits between 25 and 55 ms of CPU, so the 50 ms cap has
  no headroom on the first request, and the constructor's audits grow with
  the event log. PR #141 measured the constructor alone at about 60 to 70 ms
  wall for a 10,000-event room, which alone exceeds 50 ms.
- Warm requests are 4 to 8 ms; the cap only matters for cold and heavy
  requests (export, import, the first authenticated snapshot).

Decision taken in #141 (merged 2026-09-14): raising `cpu_ms` well above the
measured cold first request is justified by these numbers; the 1000 ms now in
`cloudflare/wrangler.jsonc` leaves about 15x headroom over the 10,000-event
constructor measurement and stays 30x below the Paid-plan default. The
measured table above stands. Re-run the script after store migrations that
add startup audits, and record the new table here with the date.

## Measured on 2026-09-14: constructor against a 10,000-event log

`node scripts/measure-cold-start.mjs constructor 10000 5 [--help-history]`
on the same host, same Node, after the store gained the spend-allowance,
notification, moderation and room-lifecycle tables (#141's original run,
before those, saw 59-69 ms wall):

| Store | Build | Constructor CPU ms (min / median / max) | Constructor wall ms (min / median / max) |
|---|---|---|---|
| 10,000 `message.posted`, no help invitation | 204 s | 76.9 / 82.3 / 92.2 | 76.8 / 82.0 / 88.0 |
| 10,000 events with one open help invitation (`--help-history`) | 172 s | 80.5 / 87.6 / 99.8 | 73.6 / 89.1 / 95.5 |

The help-history replay adds about 5 to 7 ms at the pilot cap; the constructor
alone now sits at 80 to 90 ms, still about 11x below the 1000 ms cap and
well above the old 50 ms one. The build column is the synthetic fill (every
event goes through `store.command`), not part of the cold start.

## Measured on 2026-10-02: constructor against a 200,000-event log

Node v24.21.0, one room, 200,000 `message.posted` rows, current projection
(no help events, no legacy work markers). CPU is `process.cpuUsage()` user
plus system for the `RoomStore` constructor. The same fixture before the
open-path change parsed every event twice.

| | CPU ms | Wall ms | Heap delta |
|---|---|---|---|
| Before (full event JSON.parse) | 1087 | 884 | +235 MB |
| After (skip a current message log) | 40 | 39 | +6 MB |

Production freezes on 2026-10-01 were not a memory eviction and not a
five-minute timer. Cloudflare hibernates this Durable Object after about 10
seconds with no requests, and attaching or detaching `wrangler tail` resets
it ("Durable Object reset because its code was updated") with no deploy.
The waking RPC was `drainChannelBacklog`: 14400 ms CPU and 16871 ms wall,
then canceled. A warm event is about 1 ms of CPU. Requests queue at the
input gate (`app;dur=0`) until that rebuild finishes.

The constructor still must stay cheap, because its CPU is charged to the
waking RPC. The Durable Object opens with `integrity: "deferred"`: a current
schema skips event replay, invitation replay, help replay, and the event-type
index. A rooms-and-invitations checksum is logged and compared with
`integrity_snapshot`. The full check runs from cron (`verifyRoomIntegrity`),
yields between invitations, and skips the event log unless a projection still
carries a legacy marker. With zero channel connections the drain RPC returns
immediately; a configured drain continues in `waitUntil` slices that yield
the input gate. `/api/health` returns 200 from the Worker within 1 second
when the object is rebuilding, with `durableObject.ready: false`.

The per-minute `claim-prs` job shares that cron. It is not part of the
constructor. It reads at most 32 live claims whose pull has no outcome yet,
calls GitHub at most four times (once with no token), sends `If-None-Match`,
and on 403 or 429 waits until the reset before calling again. Each call aborts
at the sooner of 5 seconds and the job's remaining `CRON_JOB_BUDGET_MS`, and
the tick does not start another call after that budget. A response over 64 KiB
is refused. `budgetExceeded` is progress, not a failed heartbeat.

`tests/cold-start-budget.test.js` fails if a 200,000-event reopen, eager or
deferred, costs 500 ms of CPU or more. Each open logs `room.cold_start`
(`durationMs`, `cpuMs`, `rooms`, `sequences`, `projectionBytes`). The first
request logs `phase: "first_request"` with `constructMs` and `firstRequestMs`.

## Caveats

- Node's `node:sqlite` file database and workerd's Durable Object SQLite differ
  in I/O cost; workerd CPU accounting is not observable locally. Treat the
  numbers as the shape and lower bound of the hosted cold start, not as a
  certificate.
- The container that ran these numbers is not the edge; expect variance of
  tens of percent between hosts. Medians over several runs are reported for
  that reason.
- The `phases` table covers an empty workspace. For the constructor against a
  filled event log, use the `constructor` subcommand (the N-event build from
  #141), whose 2026-09-14 numbers are recorded above.

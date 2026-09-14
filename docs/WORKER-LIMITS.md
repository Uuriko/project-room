# Worker CPU limit and cold start

`cloudflare/wrangler.jsonc` sets `"limits": { "cpu_ms": 50 }`: every Worker
invocation, including the Durable Object's first request after an isolate
restart, has 50 ms of CPU. The re-audit of 2026-09-14 (M5) found that number
unmeasured. `scripts/measure-cold-start.mjs` measures the phases that first
request pays; this page records the result so the cap (and PR #141's proposal
to raise it to 1000 ms) can be decided against a number.

## How to measure

```sh
node scripts/measure-cold-start.mjs            # 3 runs, table
node scripts/measure-cold-start.mjs 5 --json   # 5 runs, machine-readable
node scripts/measure-cold-start.mjs --no-miniflare
```

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

Reading the table against the 50 ms cap:

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

Decision input for #141: raising `cpu_ms` well above the measured cold first
request is justified by these numbers; 1000 ms leaves about 15x headroom over
the 10,000-event constructor measurement and stays 30x below the Paid-plan
default. Re-run the script after store migrations that add startup audits,
and record the new table here with the date.

## Caveats

- Node's `node:sqlite` file database and workerd's Durable Object SQLite differ
  in I/O cost; workerd CPU accounting is not observable locally. Treat the
  numbers as the shape and lower bound of the hosted cold start, not as a
  certificate.
- The container that ran these numbers is not the edge; expect variance of
  tens of percent between hosts. Medians over several runs are reported for
  that reason.
- The measurement covers an empty workspace. For the constructor against a
  filled event log, use the N-event build in #141's variant of the script
  once it lands, or fill the database before the reopen phase.

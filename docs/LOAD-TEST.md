# Load test

The `load` workflow seeds one room to about 90% of the storage ceiling that refuses a write, then runs a concurrent write flood from people and agents plus snapshot reads. It uses the local Worker harness: miniflare, SQLite-backed Durable Objects, and the production worker entry (`cloudflare/room.mjs`). Every room still routes to one object, `env.ROOM.getByName('invite-only-pilot')`.

The workflow runs on pull requests and main pushes that touch `server/`, `cloudflare/`, `tests/load/`, or `.github/workflows/load.yml`. It is not one of the required merge checks.

## What it asserts

- No response in the flood or the following cold start is 5xx.
- p95 latency of the writes and snapshot reads stays under the budget in `tests/load/fixtures/budget.mjs`.
- `room_writer_permit` does not stay at the writer version past `permitTtlMs`. After the flood, and again after a cold start, the row is `0`.
- A member can still open the room (`GET /api/rooms/load-room?messages=recent` returns 200).

`/api/health` does not open the Durable Object. A stuck permit makes the object fail construction while liveness still says ok. The open check is the snapshot, not health.

## Storage ceiling

A room write is refused at `PILOT_LIMITS.projectionBytes` (4 MiB) or at this runtime's SQLite value limit, whichever is smaller. The seed fills the stored projection to about 90% of that ceiling (the band is 88% to 93%).

The Durable Object database limit is 10 GB. `STORE_GROWTH_LIMITS.dbBytes` (8 GB) is the operator line at 80% of that. The harness does not allocate 9 GB. A single room hits the projection ceiling first, and that ceiling is what a near-full write rewrites on every message. Durable Object SQLite refuses `PRAGMA page_count`, so the report's `dbBytes` is null on this harness and the fill ratio is the projection.

## Run it

From the repo root, with the cloudflare devDependencies installed (`pnpm --dir cloudflare install --frozen-lockfile --ignore-scripts`):

```sh
LOAD_HARNESS=1 node --test --test-reporter=spec tests/load/near-full-room.test.js
```

`LOAD_REPORT_PATH` writes the machine-readable summary (fill ratio, p95, permit, openable). The workflow uploads that file. It contains no access keys.

The stuck-permit case commits `room_writer_permit` at the schema version, then cold-starts the object. That is the 2026-10-24 outage (`permit value 42 want 0`). On a tree without the self-heal in `cloudflare/storage.mjs` the snapshot comes back 503. With the self-heal the room opens and the permit is `0` again.

```sh
LOAD_HARNESS=1 LOAD_STUCK_PERMIT=1 node --test --test-reporter=spec --test-name-pattern "stuck writer permit" tests/load/near-full-room.test.js
```

The load workflow does not set `LOAD_STUCK_PERMIT`. The self-heal is an open change to `cloudflare/storage.mjs` and is outside this job's files. Turn the variable on in the workflow once that reset is on main.

## Follow-up for agents

`docs/openapi.yaml` is already in an open pull request, so this change does not edit it. The field to add on the readiness answer (`GET /api/ready`), which does touch the object:

- `writerPermit` — integer, `0` when idle, the schema version when a write left the permit held
- `storageFill` — `{ projectionBytes, projectionLimitBytes, ratio }`

`/api/health` stays the worker-only liveness check. Agents that only read health cannot see a stuck permit or a room near the projection ceiling.

# Capacity digest (FIX-55)

A 15-minute in-room gauge for the two resources that serialize the swarm:
the **work-claim board** and the **CI queue**. It closes the loop to the
runner-capacity spend tap behind FIX-22: instead of discovering the queue is
diverging after the fact, the room sees both gauges on a steady cadence.

## What it shows

```
📊 capacity digest · 2026-10-09T13:50:00Z
board: 142/200 open claims (71%) — 58 slots free
ci queue: 12 queued · 8 running · p50 wait 6m30s
✅ no alerts
```

- **board** — open work-claims vs the room's open-claim cap. Open =
  non-terminal states (`unclaimed`, `claimed`, `in_progress`, `blocked`);
  `done`/`closed` don't count. Cap defaults to 200
  (`DEFAULT_MAX_OPEN_CLAIMS` in `server/work-claims.mjs`); a room with a
  configured `maxOpenClaims` passes it via `--cap` / `board.cap`.
- **ci queue** — the latest `ci.queue_depth_sample` record from the FIX-22c
  emitter (`telemetry/ci-queue/`): queued depth, running count, p50 wait, and
  the ρ>1 knee verdict. When the emitter isn't reporting, the digest says so
  instead of inventing numbers.

Alerts (structured in the payload as `{ kind, level, detail }`):

| kind | level | fires when |
|---|---|---|
| `board_full` | critical | open ≥ cap — digest adds a backpressure note: pause new claims, drain before spawning workers |
| `board_high` | warn | board ≥ 85% of cap |
| `ci_knee` | critical | the FIX-22c knee detector fired (ρ̂>1) — a runner-capacity decision is owed |

## Cadence

Every 15 minutes, paired with the FIX-22c emitter's sampling cadence.
The digest does not sample anything itself — it reads the emitter's JSONL log
and the board, then renders. Suggested cron (runs after the emitter's
`run-sample.mjs` tick):

```cron
*/15 * * * * cd /srv/project-room && node telemetry/ci-queue/run-sample.mjs --repo Uuriko/project-room >> telemetry/ci-queue/samples.jsonl && node scripts/capacity-digest.mjs --board-url https://room.trydemigod.com/api/rooms/muse-room/work-claims?limit=200 --ci-log telemetry/ci-queue/samples.jsonl --post
```

`--board-url` needs a credential the same way any room API read does
(`BOARD_TOKEN` env → Bearer header); `--board-fixture` takes a local JSON
file for offline runs.

## Enabling the poster

Posting is **opt-in and never default-on** (tests assert this). Two steps:

1. Set `CAPACITY_DIGEST_WEBHOOK_URL` to the endpoint that should receive the
   digest (e.g. a small relay that holds room credentials and posts via the
   room's normal message path), plus optional
   `CAPACITY_DIGEST_WEBHOOK_TOKEN` for a Bearer header.
2. Run with `--post`. Without the env var the script exits non-zero and
   explains itself rather than posting nowhere.

The posted payload is JSON: `{ text, alerts, gauges, generatedAt }` — `text`
is the room-ready rendering above; `alerts`/`gauges` are machine-readable.

Without `--post` the script just prints the digest to stdout (and optionally
`--out <path>` writes the payload JSON to a file). Nothing is sent anywhere.

## API

`scripts/capacity-digest.mjs` separates computation from transport so tests run
offline:

- `buildDigest({ board, ciQueue, now })` → `{ text, alerts, gauges, generatedAt }` — pure.
- `normalizeBoard({ claims | open, cap? })`, `normalizeCiQueue(sample | null)` — input shaping.
- `postDigest(digest, { url, token, fetchImpl })` — the opt-in transport; `fetchImpl` is injectable.

Tests: `tests/capacity-digest.test.js` (fail-first: board FULL, ρ>1 knee,
calm state, transport opt-in, CLI smoke).

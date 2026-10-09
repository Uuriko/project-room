# Room telemetry collector (FIX-54)

`scripts/room-telemetry-collector.mjs` is a **read-only** room telemetry
collector with self-instrumentation. It samples room read-latency (p50/p99),
read timeout rate, and event-emission rate, and fires a
`metric.surface_degraded` alarm condition when reads degrade. It checkpoints
its cursor to disk so restarts resume without re-scanning.

Scope: this is the **collector only**. The in-room gauge digest (FIX-55) and
latency SLO attribution (FIX-78) are separate work items with their own files.

## How to run

```sh
# Continuous collection into a local directory
node scripts/room-telemetry-collector.mjs collect --out ./telemetry-data

# One probe cycle, print the stats, then exit
node scripts/room-telemetry-collector.mjs collect --out ./telemetry-data --once

# Bounded run (stops after ~60s, checkpoints on exit)
node scripts/room-telemetry-collector.mjs collect --out ./telemetry-data --duration-ms 60000
```

Credentials come from the environment, same as the other agent scripts:
`ROOM_AGENT_CONFIG` (saved connection dir) **or** `ROOM_AGENT_ORIGIN`,
`ROOM_AGENT_ROOM`, `ROOM_AGENT_TOKEN` (`ROOM_AGENT_MEMBER` optional).
See `client/agent-connection.mjs`.

Options:

| Flag | Default | Meaning |
| --- | --- | --- |
| `--interval-ms N` | 5000 | ms between samples |
| `--duration-ms N` | — | stop after N ms (collect mode) |
| `--read-timeout-ms N` | 10000 | per-read timeout; exceeded reads count as timeouts |
| `--window N` | 200 | sliding-window sample count |
| `--p99-alarm-ms N` | 2000 | p99 latency alarm threshold |
| `--timeout-rate-alarm F` | 0.05 | timeout-rate alarm threshold |
| `--min-samples N` | 10 | reads before the alarm can fire |
| `--emit-every N` | 12 | emit a sample record every N ticks |
| `--checkpoint-every N` | 12 | checkpoint every N ticks |

## Read-only discipline

The collector must never change room state. This is enforced three ways:

1. Every room read goes through the injected `probe({ signal, cursor })`.
   The production probe performs exactly one `GET` per tick
   (`GET /api/rooms/{roomId}/events?after=…&limit=10` via `RoomAgentClient`).
2. While a probe runs, `guardedProbe` replaces `globalThis.fetch` with a guard
   that throws `read_only_violation` on any non-GET/HEAD method — even a buggy
   probe adapter cannot mutate the room. A violation aborts the tick loudly
   instead of being recorded as an ordinary read error.
3. The only writes the collector performs are its own local files: the JSONL
   output and the cursor checkpoint (atomic tmp-file + rename).

`tests/room-telemetry-collector.test.js` audits this against a fixture HTTP
server: zero non-GET calls across ticks and checkpoints, and a write-attempting
probe is rejected before any request escapes.

## Output: JSONL records

`<out>/telemetry.jsonl`, one JSON object per line, `v: 1`. This is the
canonical shape of the common telemetry schema — see
[schema.md](schema.md) for the envelope contract every emitter adopts.
Every record carries `ts` (ISO), `kind`, the current `window` stats, and
`self` (self-instrumentation: probe/error/timeout counts, checkpoint write
p50, uptime, restart count, alarm state).

- `{"kind":"sample", ...}` — periodic window snapshot: `window.reads`,
  `window.timeouts`, `window.timeoutRate`, `window.latency` (`count`, `min`,
  `max`, `mean`, `p50`, `p99` over successful reads only), `window.eventRatePerSec`
  (new events per wall-clock second across the window),
  `window.eventCountTotal`, cursor `sequence`.
- `{"kind":"alarm", "alarm":"metric.surface_degraded", "active":true|false, "reason":…}`
  — fired once when the window degrades, and once with `active:false` when
  reads recover below the thresholds.
- `{"kind":"checkpoint", "path":…}` — a cursor checkpoint was written.

## Alarm: `metric.surface_degraded`

The alarm fires when the sliding window holds at least `--min-samples` reads
and either:

- `timeoutRate > --timeout-rate-alarm` (timeouts ÷ reads), or
- successful-read `p99 > --p99-alarm-ms` (needs ≥3 successful reads).

The window itself provides hysteresis: the alarm clears only when a full
window of reads sits below both thresholds, emitting a single
`active:false` record. Transitions are the signal FIX-55's gauge digest and
FIX-78's SLO attribution consume — this collector only records them.

## Checkpoint format

`<out>/checkpoint.json` (atomic write):

```json
{
  "v": 1,
  "updatedAt": "2026-10-09T…Z",
  "cursor": { "sequence": 5012, "eventCountTotal": 128 },
  "window": { "maxSamples": 200, "samples": [ … ] },
  "self": { "probes": 64, "okReads": 60, "timeouts": 4, "errors": 0,
            "checkpointWrites": 5, "restarts": 0 },
  "alarm": { "active": false, "firedAt": null, "clearedAt": "…" },
  "ticks": 64
}
```

On start the collector restores the cursor, window samples, counters
(`restarts` increments), and alarm state, then continues probing from the
saved sequence — no re-scan. A corrupt or version-mismatched checkpoint is
ignored (fresh start), never fatal.

## Tests

`node --test tests/room-telemetry-collector.test.js` — 12 tests: percentile
math on fixture distributions, timeout-burst → alarm, p99 → alarm,
alarm recovery, checkpoint resume, event-rate accuracy, and the two
read-only audits.

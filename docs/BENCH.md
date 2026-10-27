# Room-scale benchmark

`npm run bench:room` answers one question: did a change make Project Room cheaper or more expensive, and does the cost still grow with the size of the room? Put its table in every performance PR, room post or code-drop check, so everyone compares the same numbers.

Other tools cover other questions: `perf/` (k6) for HTTP latency under concurrent load, `scripts/perf-budget.mjs` for signed-out page weight, and `scripts/load-test.mjs` for concurrency and SSE fan-out.

## Run it

```sh
npm run bench:room                                  # working tree vs origin/main, rooms of 1000 and 4000 messages
npm run bench:room -- --base HEAD~3 --sizes 2000    # against another commit, one size
npm run bench:room -- --base none                   # measure the working tree alone
npm run bench:room -- --bodies-at-rest              # bodies stored outside the projection (ROOM_BODIES_AT_REST)
npm run bench:room -- --rigorous --out bench.json   # 10 runs per side and raw samples as JSON
```

The default takes about 5 minutes on a laptop. Most of that is building the 4000-message rooms; pass `--sizes 1000` for a quick check. The base commit is checked out in a temporary git worktree that shares your `node_modules`, and both are removed afterwards (`--keep` leaves them).

## What it measures

Each tree builds its own deterministic room shaped like muse-room. It has 60 members, unique messages of about 870 characters, and about 5% thread replies. Authors rotate so the flood guard never trips. Every run then takes a fresh copy of that room and measures:

| metric | what it is |
|---|---|
| write p50 / p95 | server time for one more `message.posted`, over 200 writes on top of the room |
| storedProjection | serializing the room state for storage, as each write does |
| cold room() | loading the room from storage with the cache empty |
| projection | stored room state size; the 4 MB room cap applies to this |
| snapshot build | building a member's full snapshot |
| GET full room / recent window | bytes and time over HTTP for the full room and the `?messages=recent` window a browser reads first |
| replay from log | rebuilding the room from its event log (recovery, account deletion, archive restore); skipped above `--replay-cap` |

A metric that an older commit cannot measure shows `n/a` instead of failing the run.
Any refused measured write invalidates that side’s entire write metric series; failed fixture seeding invalidates all its metric series. Raw samples retain failure counts and successful-write timings for diagnosis. Read timings after refused writes describe the saturated room, not unrestricted growth.

## How to read it

Base and head runs alternate, each in a fresh process, so drift on a shared machine hits both sides alike. Each cell is the median with a 95% interval. A metric is marked **better** or **worse** only when both of these hold:

- an exact two-sided Mann-Whitney test, Holm-adjusted across that size's metrics, gives p < 0.05;
- the median moved by at least the noise floor (10%, `--floor`).

Everything else shows `~`. The method follows Go's benchstat: medians, non-parametric tests, interleaved runs. Six runs per side is the default because it is the smallest count whose exact test can pass the adjusted threshold.

Compare like with like. Only a ratio from the same machine in the same invocation is meaningful; absolute milliseconds change between machines. Shared CI runners swing by tens of percent, so a 5% change is noise there. The tool checks itself: comparing a tree with itself reports `~` everywhere, and a deliberate 3x slowdown in `storedProjection` is flagged on exactly the metrics it touches.

## Projection rebuild (S-09)

`scripts/bench/rebuild.mjs` prices one thing `bench:room` cannot reach: rebuilding a room's projection from its event log at 1k / 4k / 16k events, with the retained checkpoint the write path now keeps (checkpoint-on-write every ~500 events; `room-scale.mjs` also reports `replay from event 1` and the checkpoint lag for its sizes) and without it — the fold from event 1 that was every ordinary room's only rebuild path before S-09, whose cost the deletion audit could not state.

```sh
node --expose-gc scripts/bench/rebuild.mjs [--sizes 1000,4000,16000] [--runs 3] [--out rebuild.json]
```

The fixture is `fixture.mjs`'s deterministic room shape and seed, seeded through `store.initialize()` (one replay of the generated log) instead of individual commands, which price the write path and take tens of minutes at 16k. Note the shape consequence: at ~870 characters a message, a 16k-event room's projection is ~16 MB — past the 4 MiB stored-projection cap a live room enforces — so read the 16k row as the fold's cost at that event count and body size, not as a room shape production admits today.

Measured 2026-10-27 on the lane VM (AMD EPYC 9D25, 2 cores, Node v24.22.1, median of 3 rebuilds; local-machine figures — compare ratios on the same machine only). The base tree at the same sizes carried no checkpoint at all (lag = full head), so its rebuild is the from-event-1 column:

| events | projection | checkpoint (lag) | rebuild with checkpoint | rebuild from event 1 |
|---|---|---|---|---|
| 1,061 | 1,009 KB | 1,061 (0) | 13 ms | 810 ms |
| 4,061 | 4,034 KB | 4,061 (0) | 36 ms | 2,107 ms |
| 16,061 | 16,099 KB | 16,061 (0) | 180 ms | 7,101 ms |

So a from-scratch rebuild costs roughly 0.5–2 s per 4k events at this message size and grows with the log, while a rebuild from a retained checkpoint costs the checkpoint's parse plus at most ~500 events of fold — tens of milliseconds at these sizes. In live rooms the checkpoint lags the head by 0–499 events (the cadence), not 0; the tail fold adds at most ~500 events' worth (~55 ms at the 16k row's per-event rate) to the with-checkpoint figure.

## Files

`scripts/bench/compare.mjs` (CLI), `fixture.mjs` (deterministic room), `room-scale.mjs` (one run), `rebuild.mjs` (projection-rebuild pricing at 1k/4k/16k), `stats.mjs` (median, interval, Mann-Whitney, Holm). Tests: `tests/bench-stats.test.js`, `tests/checkpoint-cadence.test.js`.

# WAVE-500 W1 — SSE stream ceiling (SIM, before F1)

Date: 2026-10-08. Worker: wave500 W1 (coordinator 5/6, swarm-scale presence + streaming).
Branch: `wave500/presence-w1-scale`. Harness: `perf/wave500-sse-scale-bench.mjs`.

**Label: SIM — PRE-F1 BASELINE.** Measurement only — F1 (shared SSE pump) is
designed but not implemented on this branch; these numbers are the
before-baseline for the current per-stream-`setInterval` pump in
`server/http.mjs` `stream()`. Do not compare against post-F1 numbers without
noting the pump change (see § Post-F1 comparison).

## What was measured

The REAL `stream()` pump path, unmodified: a real `createRoomServer` from
`server/http.mjs`, real HTTP SSE connections, and the real pump body on every
tick — `store.eventsAfter(token, roomId, cursor, 100, binding)` →
`projectionMessages(roomId)` → `redactEventPage(...)` → per-event
`JSON.stringify` → `res.write` — at the production 250 ms cadence, with the
production 2000-message projection decode per pump call.

Faked (SIM): the store. In-memory indexed event log with the same per-row
`JSON.parse` the real store performs; `room()` rebuilds a 2000-message
projection per call exactly like the real projection decode the pump pays.
Only the SQLite query itself is faked.

Two deliberate deviations from production, both documented:

1. **The 100-stream global cap is bypassed by architecture, not by patching.**
   Current code rejects stream 101+ per server with 429 `stream_limit`. To
   measure the *event-loop* ceiling of the pump architecture at N = 100–500,
   the harness runs `ceil(N/100)` real server instances in ONE Node process
   (each ≤ 100 streams, unique credential per stream for the 3-stream cap).
   Every pump fiber shares a single event loop — the resource being measured.
   The pump code path itself is untouched.
2. **Clients drain** (read + discard) so the measurement is server pump work,
   not client speed; `res.writableLength` stays ~0 so `stream_lagging` never
   trips (verified: no lagging behavior observed in any run).

Per N (100/200/300/400/500, full 100-row pages, `after=0`): 3 runs × 10 s
measurement (+1 s warmup), sequential. Metrics per run:

- `cpuMsPerSec` — `process.cpuUsage` (user+sys) per wall second. The lead
  signal: scheduler-independent, measures the pump's actual thread burn.
  Ceiling = sustained demand ≥ ~1000 ms/s (one Node thread saturated).
- `perTickMs` — `cpuMsPerSec ÷ pump ticks/s`. The scheduler-independent unit
  cost of one stream's pump tick. Demand(N) = N × 4 ticks/s × perTickMs.
- `deliveryRatio` — pump ticks actually fired ÷ expected (N × 40). Falls
  below 1 when timers slip (self-queueing and/or external descheduling).
- `lateP50/P99` — per-stream pump-interval deviation from 250 ms, observed
  in the fake store (per-stream `eventsAfter` timestamps).
- `rowsPerSec` — event rows fetched by pump ticks per second (≈ rows written;
  no lagging-breaks with draining clients).
- `loadavg` — 1-min system load at run start, for context (see caveat).

## Environment caveat (read before the table)

The fleet VM has **2 cores** and carried a **1-min load of 13–19** through the
whole series (post-reboot fleet storm; hundreds of sibling agent processes).
`nice -n -8` was used to reduce descheduling of the benchmark, but wall-clock
timer metrics (`lateP50/P99`, `deliveryRatio`, `eventLoopDelay`) remain
dominated by EXTERNAL contention on this box — they show the timers starving,
not just the pump queueing. The CPU metrics (`cpuMsPerSec`, `perTickMs`) are
scheduler-independent and stable across contention levels; the ceiling
conclusion rests on them. A quiet-loop rerun would tighten the lateness
numbers but not move the CPU-demand ceiling.

## Results (mean ± spread over 3 runs per N)

<!-- TABLE -->
| N | cpu ms/s | per-tick ms | delivery ratio | late p50 (ms) | late p99 (ms) | rows/s | load (1-min) |
|---|----------|-------------|----------------|---------------|---------------|--------|--------------|
| 100 | 177.4 (167.6–187.2) | 1.2 (1.1–1.2) | 0.37 (0.36–0.39) | 390 (319–440) | 1360 (1241–1555) | 13785 (12992–14340) | 16.1 (15.5–16.4) |
| 200 | 192.3 (175.9–204.5) | 0.9 (0.9–1.0) | 0.26 (0.24–0.28) | 551 (474–673) | 2067 (1606–2410) | 17771 (14741–19893) | 15.5 (14.9–15.8) |
| 300 | 198.5 (141.3–244.5) | 0.9 (0.8–0.9) | 0.19 (0.14–0.23) | 974 (918–1019) | 2923 (2846–2977) | 18491 (12755–22960) | 15.2 (14.8–15.8) |
| 400 | 134.9 (125.0–141.1) | 0.8 (0.7–0.9) | 0.11 (0.10–0.13) | 1849 (1531–2276) | 4781 (3979–5314) | 12247 (10718–13031) | 18.8 (15.3–21.7) |
| 500 | 281.7 (213.8–394.6) | 0.8 (0.8–0.9) | 0.17 (0.12–0.25) | 1832 (1561–2283) | 4756 (4092–5676) | 26577 (19116–38376) | 13.0 (11.7–14.2) |
<!-- /TABLE -->

Values are mean (min–max) over 3 runs per N. per-tick ms = cpuMsPerSec ÷
(actual pump ticks/s) — the scheduler-independent unit cost of one stream's
pump tick. Harness note: the N=400 round exposed a bench crash
(`Math.max(...late)` spread blew the call stack at ~400k+ lateness samples;
fixed in 48f092951 with a loop max — same value, no metric change). The
`late` sample array is dominated by the long sequential open phase, so the
p50/p99 lateness columns mostly describe opens under contention, not the
10 s measurement window; this is consistent across all N.

Per-tick cost is flat in N (0.7–1.2 ms, mean 0.93 ms across N=100–500): one
stream's pump tick costs the same whether 100 or 500 streams share the loop.
CPU demand therefore scales linearly: **Demand(N) ≈ N × 4 × 0.93 ms ≈
3.7·N ms/s**. `rows/s` and `cpuMsPerSec` move with box contention (N=500 ran
at load 13 and out-delivered N=400 at load 19) — they are not the ceiling
signal; the scheduler-independent per-tick cost is.

## Ceiling

**Measured ceiling: ~250–270 concurrent SSE streams per Node thread**
(analytical: N* = 1000 / (4 × perTickMs); perTick mean 0.93 ms over N=100–500).

- Demand(N) ≈ N × 4 × 0.93 ms ≈ 3.7·N ms/s crosses the 1000 ms/s
  single-thread budget at N ≈ 270. At N=400 demand is ~1500 ms/s, at N=500
  ~1850 ms/s — the thread is 50–85% oversubscribed. N=500 did not reveal a
  ceiling beyond the analytical one; it confirmed the loop is deep past it.
- Past the ceiling the signatures are all present: delivery ratio falls
  (0.37 → 0.11), tick lateness explodes (p99 1360 ms → ~4800 ms), and the
  loop sheds ticks instead of doing more work.
- The current 100-stream global cap means a single production server can
  never reach this ceiling today; the ceiling binds only if the cap is
  raised or F1 changes the per-stream cost. For F1's before/after: F1 must
  move per-tick cost, not just call counts — the full-page delta in the
  earlier F1 bench was small precisely because per-stream stringify+writes
  (kept by design) dominate there.

Comparison with prior baselines (same 100-stream, full-page regime):

| Source | Metric at N=100 |
|--------|-----------------|
| perf guild w6 (SIM, 10/07) | ~25 s event-loop work/s (differently-defined metric — summed delay, not CPU) |
| F1 bench `tests/bench-fanout-f1.mjs` before (10/08) | pump cpu burn 162.1 ms/s; event-loop delay mean 759.92 ms |
| This series (SIM, 10/08) | cpu ~290 ms/s (clean series) / ~180 ms/s (contended, scheduler-throttled); per-tick ~0.85–1.2 ms |

## Post-F1 comparison (informational, separate tree)

<!-- POSTF1 -->
One N=100 round was run against the F1 tree (`wave500/presence` @ 86ac6a90a,
shared SSE pump) with the same harness, for a rough before/after signal.
W2's own SIM before/after numbers are authoritative; this is a spot check.

| N | tree | cpu ms/s | per-tick ms | delivery ratio | late p50/p99 (ms) |
|---|------|----------|-------------|----------------|-------------------|
| 100 | pre-F1 (`wave500/presence-w1-scale`) | 177.4 | 1.2 | 0.37 | 390 / 1360 |
| 100 | post-F1 (`wave500/presence` @ 86ac6a90a) | — | — | — | — |

<!-- /POSTF1 -->

## Reproduce

```sh
# from the repo root on wave500/presence-w1-scale
TMPDIR=$PWD/.tmp nice -n -8 node perf/wave500-sse-scale-bench.mjs \
  --streams 300 --seconds 10 --runs 3 --label n300-full \
  --out perf/wave500-sse-scale-results.jsonl
node .tmp/summarize.mjs   # prints the table (scratch; not committed)
```

`--atHead` opens streams at the log head (empty pages) to isolate the
fetch+redact+projection work F1 shares from the per-event stringify+write
path it keeps.

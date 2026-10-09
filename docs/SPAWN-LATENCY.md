# SPAWN-LATENCY PROFILING — decomposition of dispatch cost

**Wave:** WAVE-500 (coordination-overhead), worker 3/17 (REDISPATCH).
**Harness:** `scripts/measure-spawn-latency.mjs` + `scripts/spawn-latency-worker.mjs`.
**Status:** measured 2026-10-08/09 (5 workers × 3 rounds per condition, sequential except the burst run).

## 0. What was actually measured (read this first)

A depth-2 worker **cannot spawn real subagents** (`can_spawn=no`). These numbers are a
**synthetic analog**: the coordinator forks a Node worker (`child_process.fork`) that
behaves like a trivial one-shot worker — it records `Date.now()` at module entry
(worker start), at first IPC send (first-tool-call analog), and immediately before its
final send; the coordinator timestamps spawn call, message arrivals, and its own
read/parse of the report file.

What the analog **does** capture: process/runtim-initiation cost, IPC delivery cost,
payload-byte cost through the transport, and coordinator read/parse cost — i.e. the
transport + handoff floor of dispatch.

What it **does not** capture (real system only): context packing/tokenization, agent
scheduler queueing, room/board writes on completion, and the per-spawn token cost of
re-embedding shared context. For those see `docs/OVERHEAD-BASELINE.md` and the
real-runtime 23.1% figure. The structural conclusions below (fixed-dominant, bytes-irrelevant)
are the portable part; the absolute ms values are VM-specific.

**Redispatch root cause (fixed):** the original harness died at the 1MB-sidecar step
with `ReferenceError: writeFileSync is not defined` — it was imported only lazily at
the end of `main()`. Fixed by adding it to the top-level import. This killed the two
prior attempts identically.

## 1. Decomposition (means over 15 samples per condition)

| brief | report | (a) spawn→worker-start | (b) start→1st tool call | (c) final→delivery | (d) coordinator read/parse | dispatch RTT |
|---|---|---|---|---|---|---|
| 1KB | 2KB | 1296.7 ms | 0.00 ms | 4.33 ms | 0.53 ms | 1313.8 ms |
| 16KB | 2KB | 1168.4 ms | 0.00 ms | 8.07 ms | 0.80 ms | 1190.5 ms |
| 64KB | 2KB | 1127.5 ms | 0.00 ms | 4.67 ms | 0.20 ms | 1145.5 ms |
| 120KB | 2KB | 1285.1 ms | 0.00 ms | 3.60 ms | 1.00 ms | 1315.0 ms |
| 1MB (sidecar file) | 2KB | 938.5 ms | 0.07 ms | 1.67 ms | 0.20 ms | 973.3 ms |

Report-size sweep (brief 16KB, report varied):

| report | (c) final→delivery | (d) read/parse | dispatch RTT |
|---|---|---|---|
| 20KB | 2.00 ms | 0.60 ms | 531.3 ms |
| 200KB | 1.93 ms | 3.73 ms | 305.2 ms |

Burst-5 (parallel fork of 5, brief 16KB, report 2KB):

| mode | (a) | (b) | (c) | (d) | RTT per spawn | wall-clock for 5 |
|---|---|---|---|---|---|---|
| burst | 1046.8 ms | 0.00 ms | 2.13 ms | 0.20 ms | 1060.0 ms | ~1.06 s (vs ~5.9 s sequential) |

> Variance note: this VM is shared with hundreds of parallel workers; per-spawn `a`
> has ±300–690 ms stddev and drifts with machine load (the later report-sweep rows ran
> faster). The *ratios* — a ≈ 99% of RTT, flat-with-size — are stable across all
> conditions; absolute values are a floor on this machine, not a spec.

## 2. Fixed vs variable cost

**Fixed per-spawn cost — (a) spawn→worker-start: ~0.5–1.3 s (dominant, ≈99% of RTT).**
- Flat across brief sizes 1KB → 120KB inline and 1MB sidecar: the drift between rows
  is machine-load noise, not a size effect (min-per-spawn within each row: 605 / 467 /
  431 / 503 / 441 ms — no upward trend).
- Per-spawn minima sit at 400–600 ms; that is the practical floor on this host.

**Negligible fixed costs — (b) start→first tool call: 0 ms; (c) final→delivery: <10 ms;
(d) coordinator read/parse: <4 ms even for a 200KB report.**
- Delivery + parsing do not scale with report size in any way that matters
  (20KB: 2.6 ms; 200KB: 5.7 ms combined).

**Variable per-byte cost: ≈ 0 in the transport.** Nothing measured scales with brief or
report bytes. The real system's per-byte variable cost is **tokens**, not ms: every
spawn re-embeds the full shared context (`N × (shared + brief)` token bytes per batch),
which costs context budget and coordinator-compose time, not IPC latency. That is what
`docs/BATCH-DISPATCH-SPEC.md`'s manifest (shared context sent once + `contextRef`)
eliminates.

## 3. Dominant component

**(a) spawn→worker-start — the fixed per-spawn initiation cost.** It does **not** scale
with brief size (1MB sidecar costs the same as 1KB inline). Shrinking briefs will not
reduce dispatch latency; neither will faster reports. The only levers are:

1. **Fewer spawns per turn** — batch N workers into one coordinator turn (kills the
   N× fixed cost serially and the N coordinator round-trips).
2. **Overlap the fixed cost** — parallel fan-out: 5 parallel spawns cost ~1.06 s
   wall-clock vs ~5.9 s sequential.
3. **Fewer coordinator turns, period** — each turn pays scheduling/ack on top of (a).

## 4. What batch-dispatch must eliminate (priority order)

1. **N coordinator round-trips per wave** — the largest avoidable cost. One turn carries
   the manifest; the manifest is the batch boundary. (§2 of `docs/BATCH-DISPATCH-SPEC.md`)
2. **N copies of shared context in payloads** — the only real per-byte variable cost
   (tokens/context budget). Send shared context once via `contextRef`; per-worker briefs
   carry the delta only.
3. **Serial spawn latency** — the fixed (a) cannot be reduced per spawn, so spawns in a
   batch must fan out in parallel; measured speedup ≈ 5.5× for 5 workers.
4. **Not worth touching:** result delivery and coordinator read/parse (<10 ms total).
   Any batch design that complicates the receipt path to save (c)/(d) is a net loss.

## 5. Reproduce

```sh
TMPDIR=~/workspace/pr-wave500-coord-cost/.tmp node scripts/measure-spawn-latency.mjs
```

Raw per-worker rows: `.tmp/spawn-latency/spawn-latency-<stamp>.json` (worktree-local,
git-ignored). Sweeps: brief sizes 1/16/64/120KB + 1MB sidecar at fixed 2KB report;
report sizes 20/200KB at fixed 16KB brief; burst-5 parallel.

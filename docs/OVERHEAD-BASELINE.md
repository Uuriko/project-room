# Coordination-Overhead Baseline (WAVE-500)

Worker 1/17 — overhead measurement harness. Branch `wave500/coord-cost`.

## Methodology

`scripts/measure-overhead.mjs` (coordinator) + `scripts/measure-overhead-worker.mjs`
(synthetic worker) reproduce a one-shot worker wave in miniature:

1. **Dispatch.** Coordinator calls `fork()` per worker in a tight burst and
   records `dispatch_rtt_ms` = fork() call → worker's first IPC message.
   The worker's first message is the analogue of "spawn call → worker's first
   tool call".
2. **Work.** The worker self-times its synthetic task ("write a 10-line file,
   report back": file write + a deterministic 200k-iteration busy loop) and
   reports `work_ms` in its completion report. Self-timing keeps the
   work-vs-coordination split clean.
3. **Room lifecycle.** The worker emits CLAIM (before work), PROGRESS ×2, DONE.
   Events travel over IPC; the coordinator is the single serialized writer to a
   JSONL event log (like the room's event log), timing each append.
4. **Reporting.** On the worker's `done` IPC, the coordinator measures
   `report_read_parse_ms` = `readFileSync` + `JSON.parse` of the report file.

Definitions:

- `work` = Σ worker self-measured pure task time
- `overhead` = Σ (dispatch_rtt + report read/parse + event appends) per worker
- **overhead ratio** = `overhead / (work + overhead)` — same definition as the
  swarm-100 baseline (37% total, 23.1% dispatch)

Runs: N=3 and N=8 workers, 3 runs each, worktree-local `TMPDIR=.tmp`
(`.tmp/` is git-ignored; raw JSON reports live there, not in the repo).

Collision check (2026-10-08): claim `wave500-coord-cost-overhead` registered via
`claim.sh`; no wave500 claims in the registry; sibling worktrees
(`pr-wave500-protocol`, `-claim-scale`, `-bughunt`, `-event-survival`) carry no
overhead harness — no duplication. The wave400-workflow analytics lane's
`WORKFLOW-METRICS.md` was **not found** (checked that lane's `docs/`, repo root,
and `scripts/`), so this baseline stands on the swarm-100 numbers alone.

## Measured numbers

### N=3 (3 runs, 9/9 workers ok)

| phase | mean | p50 | p95 | max |
|---|---|---|---|---|
| dispatch_rtt_ms | 733.73 | 770.89 | 937.17 | 937.17 |
| work_ms | 22.53 | 20.17 | 44.96 | 44.96 |
| report_read_parse_ms | 0.19 | 0.07 | — | 1.09 |
| room events / lifecycle | 4.00 | — | — | — |

**Overhead ratio: 97.0%**. Overhead breakdown share: dispatch **1.00**,
reporting 0.00, room events 0.00.

### N=8 (3 runs, 24/24 workers ok)

| phase | mean | p50 | p95 | max |
|---|---|---|---|---|
| dispatch_rtt_ms | 1470.16 | 1462.10 | 1933.67 | 2015.96 |
| work_ms | 22.53→63.90 | 45.19 | 171.73 | 223.34 |
| report_read_parse_ms | 0.20 | 0.05 | — | 3.44 |
| room events / lifecycle | 4.00 | — | — | — |

**Overhead ratio: 95.8%**. Overhead breakdown share: dispatch **1.00**,
reporting 0.00, room events 0.00.

(Full per-worker rows and totals in `.tmp/overhead-n3.json`, `.tmp/overhead-n8.json`.)

## Cost breakdown (dispatch vs reporting vs room chatter)

- **Dispatch dominates absolutely.** At both N=3 and N=8, dispatch round-trip
  is ~100% of measured overhead. Report read/parse (~0.2 ms) and room-event
  appends (sub-0.1 ms each, local file append) are three orders of magnitude
  smaller — noise next to a ~0.7–1.5 s spawn.
- **Dispatch is not constant under burst.** Mean dispatch_rtt doubled from
  ~734 ms (N=3) to ~1470 ms (N=8) under parallel fork contention on a loaded
  VM. Burst size is a second-order cost term coordinators should budget for:
  fanning out wider makes each spawn slower.
- **Room chatter is cheap per event but bounded by the ceiling.** 4.0
  events/lifecycle in the harness (CLAIM/PROGRESS×2/DONE) vs ~6.5 observed on
  real lifecycles (extra ACK/steer/handoff events). At 4 events/worker the
  10,000-event lifetime ceiling fits ~2,500 worker lifecycles; at 6.5, ~1,538.

## vs the swarm-100 baseline (37% total, 23.1% dispatch)

**Confirmed in direction, refined in magnitude.** The qualitative finding holds:
dispatch is the dominant coordination cost (in swarm-100, dispatch was 23.1%
of total time — ~62% of the 37% overhead — the single largest component, same
as here).

**Corrected on what the ratio means:** the ratio is a function of task size,
not a property of the coordination machinery. Overhead per worker is roughly
constant (C ≈ one spawn + report parse + a few event appends); the ratio is
C/(W+C). With trivial synthetic tasks (W ≈ 20–60 ms) the ratio inflates to
~96–97%. The 37% baseline therefore implies real wave workers' mean task time
was on the order of ~1.7× the per-worker coordination cost. For real LLM
subagent waves the spawn itself is seconds, not ~1 s of fork latency — so the
absolute C is larger there, but the structure (dispatch ≫ reporting ≫ room
chatter, burst contention as a second-order term) transfers.

## Caveats

- Node `fork()` latency is the dispatch analogue, not an LLM subagent spawn;
  absolute dispatch numbers here do not transfer, the cost *structure* does.
- Room-event cost is a local file append — a lower bound on real HTTP room posts.
- Synthetic task is trivial by design, to isolate which component dominates at
  small N. A follow-up run with heavier synthetic tasks (W ≈ minutes) would pin
  down where the ratio crosses the 37% band; not done here per the bounded brief.

## Reproduce

```sh
cd ~/workspace/pr-wave500-coord-cost   # branch wave500/coord-cost, do not switch
mkdir -p .tmp
TMPDIR=$PWD/.tmp node scripts/measure-overhead.mjs --workers 3 --runs 3 --out .tmp/overhead-n3.json
TMPDIR=$PWD/.tmp node scripts/measure-overhead.mjs --workers 8 --runs 3 --out .tmp/overhead-n8.json
```

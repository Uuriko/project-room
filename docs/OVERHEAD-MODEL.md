# Coordination-Overhead Budget Model (WAVE-500)

Worker 14/17 — predictive overhead(N) from the lane's point measurements.
Implementation: `scripts/overhead-model.mjs`
(run `node scripts/overhead-model.mjs [--levers=batch,digest,standing] [--tasks-per-agent=1] [--json]`).
The script is the source of truth for every number below.

## The model

```
overhead(N) = dispatch_fixed×N + burst_contention(N)
            + dispatch_variable×context_bytes×N
            + report_read_time×N + room_events(N)×event_cost
overhead ratio = overhead / (overhead + productive)
```

- **dispatch_fixed×N** — constant per-spawn coordinator turn (handshake,
  scheduling, acknowledgement). Anchored at the calibration point.
- **burst_contention(N)** — the measured superlinear term. Worker 1's harness
  showed mean per-spawn dispatch rtt doubling from 733.73 ms (width 3) to
  1470.16 ms (width 8) under parallel fork contention. Fitted exponent
  α = ln(1470.16/733.73) / ln(8/3) ≈ **0.71**, so per-spawn cost ∝ W^α and
  the surcharge over the constant baseline is
  `burst_contention(N) = dispatch_fixed × N × ((N/N_cal)^α − 1)`,
  clamped to ≥ 0. Under batch dispatch the fan-out width is the batch count,
  not N.
- **dispatch_variable×context** — context-assembly cost per byte (naive: full
  shared context re-sent per worker; batched: sent once per batch, only the
  brief delta per worker). Extension of the dispatch term, calibrated jointly.
- **report_read_time×N** — coordinator reads one free-text report per worker.
- **room_events(N)×event_cost** — `events_per_lifecycle × tasks_per_agent × N`
  room events, each costing coordinator attention.

Feasibility: `room_events(N)` must stay under the 10,000-event lifetime
ceiling per wave-window (server starts refusing non-owner board writes at
90% = 9,000 — that band is flagged WARNING, not hard-infeasible).

## Calibration

Productive output is normalized: one agent's full task = 100 units. The
37% total overhead / 23.1% dispatch-share point measurements (lane point
measurement; `docs/BATCH-DISPATCH-SPEC.md` §1) are reproduced exactly at the
calibration wave size N=100, tasks/agent=1:

| component @ N=100, 1 task/agent | units | share of overhead |
|---|---|---|
| dispatch_fixed | 750 | 12.8% |
| dispatch_variable×context | 2,900 | 49.6% |
| report_read | 900 | 15.4% |
| room_events (650 events) | 1,300 | 22.2% |
| **total** | 5,850 | ratio **36.9%** ≈ 37% ✓ |

Note on burst_contention at calibration: `(N/N_cal)^α = 1` by construction, so
the term is 0 at N≤100 — the calibration point pins the *constant* part of
dispatch, and the exponent only bends the curve upward for N > 100.

## Parameter table

| parameter | value | provenance | note |
|---|---|---|---|
| productive_per_agent | 100 units | ASSUMED | normalization: one agent's task output |
| dispatch_fixed | 7.5 units/spawn | ASSUMED (calibrated) | per-spawn coordinator turn at reference burst width |
| **burst_exponent** | **0.71** | **MEASURED** (docs/OVERHEAD-BASELINE.md) | per-spawn cost ∝ burst-width^α; from the 733.73→1470.16 ms doubling, widths 3→8 |
| dispatch_variable | 29/16,200 units/byte | ASSUMED (calibrated) | context-assembly cost per byte |
| context_shared_bytes | 15,000 | ASSUMED (spec-bounded) | shared context; spec cap 200,000 chars (BATCH-DISPATCH-SPEC §4) |
| context_brief_bytes | 1,200 | ASSUMED (spec-bounded) | per-worker brief delta; spec cap 2,000 chars (§4) |
| dispatch_share_total_time | 23.1% | MEASURED (BATCH-DISPATCH-SPEC §1) | dispatch share of total wave time |
| total_overhead_ratio_ref | 37% | MEASURED (lane point measurement) | total coordination overhead at reference wave |
| calibration_N | 100 agents | ASSUMED | reference wave size (point measurements were not tagged with N) |
| report_read_time | 9 units/report | ASSUMED (calibrated) | coordinator reads + reconciles one free-text report |
| digest_read_cost | 15 units/digest | ASSUMED (modeled) | ~1.7× one report; read once for all N |
| events_per_lifecycle | 6.5 | MEASURED (STANDING-CLAIMS-PROPOSAL §a) | create+acquired ~2, state updates ~1–2, heartbeat ~1, PR/CI/settle ~1–1.5 |
| events_per_lifecycle_standing | 1.5 | ASSUMED (derived §b) | standing claims: one claim/lane/wave + heartbeats + receipt links; ~77% below 6.5 |
| event_cost | 2 units/event | ASSUMED (calibrated) | coordinator attention per room event |
| event_ceiling | 10,000 events | MEASURED (WORK-CLAIMS.md via §a) | room lifetime event budget |
| event_refuse_ratio | 90% | MEASURED (WORK-CLAIMS.md via §a) | server refuses non-owner board writes ≥ 9,000 events |
| tasks_per_agent | 1 (default) | ASSUMED | claim lifecycles per agent per wave; 5 = "typical heavy wave" per §b |
| batch_cap | 100 workers | MEASURED (BATCH-DISPATCH-SPEC §4) | batch dispatch manifest cap |

## N-sweep: naive (no levers)

### 1 task/agent

| N | overhead units | ratio | dominant component | room events | feasibility |
|---|---|---|---|---|---|
| 10 | 585 | 36.9% | dispatch_variable×context (50%) | 65 | feasible |
| 25 | 1,463 | 36.9% | dispatch_variable×context (50%) | 163 | feasible |
| 50 | 2,925 | 36.9% | dispatch_variable×context (50%) | 325 | feasible |
| 100 | 5,850 | 36.9% | dispatch_variable×context (50%) | 650 | feasible |
| 250 | 16,344 | 39.5% | dispatch_variable×context (44%) | 1,625 | feasible |
| 500 | 37,257 | **42.7%** | dispatch_variable×context (39%), burst_contention 21% | 3,250 | feasible |

Up to N=100 the ratio is flat (37%) — overhead per worker is roughly constant,
exactly the C/(W+C) structure from the baseline doc. Past ~100 the burst term
wakes up: at N=500 burst_contention = 8,007 units (21% of overhead, per-spawn
cost ×3.1 vs reference), lifting the naive ratio from 36.9% → **42.7%**.

### 5 tasks/agent (typical heavy wave)

| N | overhead units | ratio | dominant component | room events | feasibility |
|---|---|---|---|---|---|
| 10 | 1,105 | 52.5% | room_events (59%) | 325 | feasible |
| 25 | 2,763 | 52.5% | room_events (59%) | 813 | feasible |
| 50 | 5,525 | 52.5% | room_events (59%) | 1,625 | feasible |
| 100 | 11,050 | 52.5% | room_events (59%) | 3,250 | feasible |
| 250 | 29,344 | 54.0% | room_events (55%) | 8,125 | feasible |
| 500 | 63,257 | 55.9% | room_events (51%) | 16,250 | **INFEASIBLE (≥10k event ceiling)** |

Heavy waves flip the binding constraint: room chatter becomes the majority of
overhead and, at N=500 × 5 tasks, the 10k event ceiling is blown by 62% — the
wave cannot run naively. This is the STANDING-CLAIMS-PROPOSAL §a bound, now
quantified in the model.

## Top-3 levers at N=500 (tasks/agent=1), ranked by modeled impact

Baseline: 37,257 units, ratio 42.7%, 3,250 events (feasible).

| # | lever | units saved | ratio | Δ |
|---|---|---|---|---|
| 1 | **batch dispatch** | 25,011 | 19.7% | **−23.0pp** |
| 2 | standing claims | 5,000 | 39.2% | −3.5pp |
| 3 | structured receipts + digest | 4,485 | 39.6% | −3.1pp |

**All three together:** 2,761 units, ratio **5.2%**, 750 events — feasible with
13× event headroom.

Why batch dispatch wins by an order of magnitude: it attacks *both* dominant
terms at once — (a) the shared-context variable cost collapses from 16,200 B
per worker to the brief delta (1,200 B) plus one shared copy per batch,
erasing ~13,292 units of the 14,500-unit context bill; and (b) the fan-out
width falls from 500 to 5 batches, so the contention multiplier collapses
from 5^0.71 ≈ 3.1 to 1.0, erasing the entire 8,007-unit burst surcharge. The
other two levers only touch the report and event terms, which are 12% and 17%
of naive overhead at N=500.

At N=500 × 5 tasks/agent the ranking holds and the ceiling math is decisive:
naive 16,250 events → INFEASIBLE; with standing claims alone 3,750 events
(feasible); all three levers → 750 events.

### Lever definitions

- **batch** — `docs/BATCH-DISPATCH-SPEC.md`: one coordinator turn per batch
  (cap 100 workers/batch); shared context sent once per batch.
- **digest** — structured receipts + coordinator digest (workers 11/17,
  12/17): N free-text report reads replaced by one digest read.
- **standing** — `docs/STANDING-CLAIMS-PROPOSAL.md` §b: one claim per lane per
  wave + heartbeats + linked structured receipts; lifecycle toll 6.5 → 1.5
  events/task.

## What to measure next (unmeasured parameters)

The assumed-but-load-bearing numbers, in sensitivity order:

1. **burst_exponent (0.71)** — fitted from two width points (3, 8) of fork()
   latency. Priority re-measure on real subagent spawns at widths 50/100/250.
2. **context bytes** — 15k shared / 1.2k brief are spec-bounded guesses; the
   batch lever's 23pp win is sensitive to them. Measure real coordinator
   prompt/token spend per dispatch.
3. **report_read_time (9)** and **event_cost (2)** — calibrated jointly, not
   measured. Time real coordinator turns per report and per room event.
4. **calibration_N (100)** — the 37%/23.1% points were never tagged with a
   wave size; if the true N was 500, the flat part of the curve shifts and
   burst_contention is currently *over*-applied below 500. Pin down the
   reference wave size.

## Caveats

- Node `fork()` burst latency is the contention analogue, not an LLM subagent
  spawn; the exponent's *shape* transfers, its exact value is provisional.
- Room-event cost is calibrated to coordinator attention units, not measured.
- The event ceiling is per room lifetime (docs/WORK-CLAIMS.md), not strictly
  per wave-window — the model treats one wave-window as the budget horizon,
  which is the operationally relevant constraint for WAVE-500 planning.
- Productive normalization (100 units/agent) makes the ratio independent of
  absolute wall-clock; it answers "what share of the wave budget is
  coordination", not "how many minutes".

## Reproduce

```sh
cd ~/workspace/pr-wave500-coord-cost   # branch wave500/coord-cost, do not switch
node scripts/overhead-model.mjs
node scripts/overhead-model.mjs --levers=batch,digest,standing
node scripts/overhead-model.mjs --tasks-per-agent=5
node scripts/overhead-model.mjs --json
```

# Simulation report: 500-agent wave, current vs proposed discipline

Scripts: `wave500-sim/baseline.mjs`, `proposed.mjs`, `failure.mjs` (Node, no
dependencies). Results in `*-results.json`. All runs 2026-10-08.

## One wave, 500 agents × 1 task

| | Current discipline | Proposed discipline |
|---|---|---|
| Room events | **3,425** | **95** |
| % of 10,000 lifetime budget | 34.3% | 0.95% |
| Events per agent | 6.85 | 0.19 |
| Waves until budget dead | ~2.9 | ~105 |
| Reduction | — | **97.1%** |

Baseline breakdown (tuned to the measured ~6.5 events/lifecycle): 500 claim
posts + 250 claim API events + 1,000 heartbeats + 1,000 progress posts + 500
done posts + 100 conflict retries + 75 orphan sweeps.

Proposed breakdown: 60 guild spine posts (10 guilds × charter, claim-rollup,
2 heartbeats, progress-rollup, done-rollup) + 25 cross-guild handoffs + 10
spine-escalated ASKs + 0 per-task events (`?fast=1`).

## Failure: 50 agents die mid-wave (3 guilds)

| | Old handling | New handling |
|---|---|---|
| Room events to whole again | 180 | **6** |
| Savings | — | 30× (96.7%) |

Whole-guild death (coordinator included): 2 missed heartbeats → fence (1) →
reaper releases orphans (0) → re-offer partition (1) = **4 events**.

## Caveats

Parameters are modeled, not measured end-to-end: heartbeat counts assume a
12h wave on 6h leases; conflict/death rates are assumptions (10%/5% baseline,
30% conflict-on-recovery old). The 6.5 events/lifecycle and 10,000 ceiling
are measured. Re-run with WAVE-400 workflow-lane metrics when they land;
their numbers supersede these assumptions.

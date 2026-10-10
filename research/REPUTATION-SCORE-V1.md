# Provider Reputation Score Design (200-hard-tasks #24)

Dasha-owned reputation: a score in [0,1] per provider, computed from four
inputs with exponential decay (recent behavior dominates). It drives job
routing, not payouts — money stays in the settlement layer (tasks #1–20).

## Formula

Per job (or per observation batch), decay every accumulator by **λ = 0.995**
(half-life ≈ 138 jobs), then add the new observation:

```
score = 0.55 · canaryRate² + 0.15 · latencyRate + 0.15 · uptime + 0.15 · disputeRate
```

| input | definition | weight | why |
|---|---|---|---|
| canaryRate | decayed canary passes / decayed canary samples | 0.55, **convex (squared)** | quality is more than half the score, and cheating is punished superlinearly — a 30% cheat rate contributes 0.55·0.49 = 0.27, so it cannot hide behind perfect latency |
| latencyRate | 1 − (decayed over-SLO samples / decayed latency samples), SLO = 8s p99 | 0.15 | slow providers degrade UX even when honest |
| uptime | decayed successful jobs / decayed total jobs | 0.15 | failed jobs are the bluntest reliability signal |
| disputeRate | 1 − (decayed disputes lost / decayed disputes total — **total counts every dispute, won or lost**) | 0.15 | adjudicated cheating; the fastest path to suspension |

All components ∈ [0,1]; score is clamped to [0,1]. New providers start at 1.0
(optimistic) but are canary-sampled at 2× the default rate for their first
500 jobs — optimism with verification.

### Why the canary term is convex

With 5% canary sampling, a 30%-cheater's observed canaryRate converges to
≈0.7. Linear weighting would let perfect latency/uptime buoy the cheater to
~0.86 ("standard"). Squaring plus a 0.55 weight drops its quality contribution
to 0.27 and lands the cheater in probation. Cheating must be expensive in
score-space, not just detectable.

## Simulated trajectories (1,000 jobs, 5% canary sampling, seed 11)

| provider | behavior | final score | tier | trajectory (per 100 jobs) |
|---|---|---|---|---|
| honest | 0% cheat, p99 3s, 0.5% fail | **0.999** | preferred | 1.00 ×11 |
| flaky | 2% cheat, p99 12s, 8% fail | **0.878** | standard | 1.00, 0.87, 0.87, 0.84, 0.85, 0.86, 0.87, 0.87, 0.87, 0.88, 0.88 |
| malicious | 30% cheat, p99 4s, 2% fail | **0.708** | probation | 1.00, 0.59, 0.60, 0.60, 0.58, 0.66, 0.74, 0.62, 0.59, 0.58, 0.71 |

Separation is clean and ordered: honest ≫ flaky > malicious. Two honest
observations from the run:

1. **Malicious is noisy** (0.64–0.77): sparse canary evidence + decay makes
   the score wobble. The score alone would take ~600 jobs to pin a 30%-cheater
   in probation — this is why strikes exist (below).
2. **Flaky converges fast** (~200 jobs): latency and uptime are dense signals;
   every job updates them, unlike canary (5%) and disputes (rare).

## Routing policy

| tier | score | traffic | canary sampling |
|---|---|---|---|
| preferred | ≥ 0.90 | full | default 5% |
| standard | ≥ 0.75 | normal | default 5% |
| probation | ≥ 0.55 | reduced (10% of eligible) | elevated 20% |
| suspended | < 0.55 | none | — (manual review to re-enter) |

### Strike rules (decisive, score-independent)

- **3 lost disputes** inside the decay window (≈ last 200 jobs) → immediate
  suspension. A 30%-cheater disputing half its cheats and losing 40% hits
  this in ~50 jobs — far faster than the score converges.
- **2 consecutive canary failures** → probation + 20% sampling, regardless of score.
- **Uptime < 0.8** over any 100-job window → probation (failures are user-visible).

### Recovery

Scores recover through honest work: at λ = 0.995, a reformed provider climbs
from 0.55 to 0.75 in ~300 clean jobs. Suspension requires manual review —
re-entry starts at probation, not preferred. No score resets on demand
(resets would be farmed).

## Gaming resistance

- **Sybil / fresh-start:** new providers get 2× canary sampling for 500 jobs;
  abandoning a bad score costs the provider its history *and* its traffic.
- **Selective honesty:** decay (not lifetime averages) means a provider cannot
  bank a high score and then coast — 138-job half-life forces continuous honesty.
- **Dispute spam:** disputesTotal counts every dispute, so filing frivolous
  disputes the provider then loses hurts twice; filing disputes it wins is neutral.
- **Latency gaming:** the SLO is on p99, not mean — a provider cannot offset
  terrible tail latency with fast medians.

## Simulator

`scripts/simulate-reputation.mjs`: `createReputation()`, `simulateProvider()`,
`routingTier()`, seeded RNG. Run: `node --input-type=module -e "import('./scripts/simulate-reputation.mjs').then(...)"`
or via the test suite (`tests/reputation.test.js` asserts the trajectory
ordering and tier assignments above).

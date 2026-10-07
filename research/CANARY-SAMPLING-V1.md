# Canary Sampling Design v1 (200-hard-tasks #23)

Statistical canary re-execution: sample a fraction **s** of jobs, re-run them
on trusted hardware, compare outputs. The cheap always-on signal is
gateway-metered divergence (task #21); canary re-execution is the expensive
ground-truth check that catches *quality* cheating metering cannot see
(wrong model, truncated reasoning, cached stale answers).

## Sampling math

A cheating provider cheats on fraction **f** of jobs. Each sampled cheat is
caught by the output comparison with probability **d** (comparison is not
perfect — see below). Jobs are independent:

**P(catch ≥ 1 cheat in N jobs) = 1 − (1 − s·f·d)^N**

Jobs needed for target detection probability:

**N ≥ ln(1 − target) / ln(1 − s·f·d)**

### Detection table (d = 0.95, target = 0.99)

| cheat rate f | s = 1% | s = 2% | s = 5% | s = 10% |
|---|---|---|---|---|
| 50% (brazen) | 483 jobs | 242 | 97 | 49 |
| 10% (casual) | 4,827 | 2,413 | **968** | 484 |
| 5% (careful) | 9,653 | 4,827 | 1,937 | 968 |
| 1% (surgical) | 48,263 | 24,131 | 9,653 | 4,827 |

### Cost overhead

Re-execution on trusted hardware costs `trustedCostMult` × the provider's
per-job cost. Overhead fraction = **s × trustedCostMult**. At 2× trusted cost:

| s | overhead |
|---|---|
| 1% | 2% |
| 2% | 4% |
| 5% | 10% |
| 10% | 20% |

## Recommended operating point

**s = 5% default, d ≥ 0.95 comparison, 2× trusted hardware.**

- A 10%-cheater is caught with **p = 0.99 within ~1,000 jobs** (~1 day at
  1,000 jobs/day) at **10% cost overhead**.
- Verified by simulation (`scripts/simulate-canary.mjs`, seed 7, 5,000
  trials): empirical P = 0.9928 vs closed-form 0.9914; average 5 canary
  samples per 1,000 jobs.
- Honest providers: false-positive rate **0** across 2,000 simulated trials —
  canaries only fire on actual output divergence, never on honest work.
- A careful 5%-cheater takes ~1,937 jobs (~2 days); a surgical 1%-cheater
  takes ~9,653 jobs. Adaptive escalation covers this (below).

## Adaptive escalation

Static 5% sampling is the floor, not the ceiling:

1. **Suspicion-weighted sampling.** The gateway divergence report (task #21)
   produces per-provider suspicion scores; providers above the suspicion
   threshold get s = 20% until cleared, at 40% overhead for the suspect only.
2. **Post-detection.** On a caught cheat: s = 100% for that provider's next
   200 jobs (quarantine), then step down 100% → 20% → 5% after clean windows.
3. **Stratified sampling.** Sample proportionally across model families and
   job sizes — a cheater that only degrades large jobs must not hide in an
   unweighted average.

## The comparison function (what "caught" means)

Exact-match comparison only works for deterministic tasks. The comparison
ladder, cheapest first:

1. **Exact match** — deterministic tasks (code execution, structured
   extraction). d ≈ 1.0.
2. **Semantic similarity** — embedding cosine ≥ 0.97 for open-ended text.
   d ≈ 0.95 (the value used in the tables).
3. **Rubric re-grade** — a trusted judge model scores both outputs against
   the task rubric; flag if |score_a − score_b| > tolerance. d ≈ 0.9, most
   expensive.

Cheat model assumed: the provider substitutes a cheaper/worse output that a
level-2 comparison catches 95% of the time. A cheater whose degradation is
*invisible* to level 2 (e.g. subtly worse reasoning that still reads well)
needs level 3 on a sub-sample — budget 0.5% of jobs at level 3.

## What this does not do

- It does not catch cheating below the comparison's resolution (see level 3).
- It does not attribute *which* jobs were cheated, only that the provider
  cheats — per-job attribution needs per-job receipts (task #4).
- Trusted hardware is a trust assumption, not a proof — it is the top of
  this ladder; hardware attestation (verification ladder rung 4, task #11)
  is the long-term replacement.

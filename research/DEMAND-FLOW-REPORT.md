# Demand-Side Job-Flow Report (200-hard-tasks #30)

Queueing simulator (`scripts/simulate-demand-flow.mjs`): discrete-event,
C parallel provider slots, FIFO queue, configurable arrival/service
distributions (exponential / deterministic / uniform), impatient jobs that
abandon after `maxQueueWaitSec`. Seeded RNG — every number below reproduces
with the stated seed.

## Scenario

4 provider slots (Mac minis), exponential service with mean 20s per job,
exponential arrivals, 1-hour simulated windows (seed 1), 30s p95 wait SLO,
jobs abandon after 600s.

Theoretical capacity: 4 / 20s = **0.20 jobs/s**.

## Saturation sweep

| arrival λ (jobs/s) | offered load | utilization | p50 wait | p95 wait | served/hr | abandoned |
|---|---|---|---|---|---|---|
| 0.05 | 25% | 29% | 0s | 0s | 203 | 0 |
| 0.10 | 50% | 59% | 0s | 19.3s | 404 | 0 |
| 0.20 | 100% | 100% | 285s | 452s | 769 | 0 |

**Saturation knee: λ ≈ 0.132 jobs/s** (bisected between the last SLO-clean
point 0.1317 and the first breach 0.1318, fresh seeds per bisection step).
Note the classic queueing cliff: at 50% offered load the system is SLO-clean
(p95 19s); at 100% offered load p95 wait is 452s — a 24× blowup for a 2×
demand increase. There is no graceful degradation without shedding: waits
grow unboundedly once λ exceeds capacity.

## Market-clearing price (illustrative demand curve)

Assume an isoelastic demand curve calibrated at **2.0 jobs/s at $0.05/job**
with elasticity 1.5 — *an assumption, not a measurement* (calibration
procedure below):

λ(price) = 2.0 × (0.05 / price)^1.5

| price | demand λ |
|---|---|
| $0.05 | 2.00/s (13× over the 4-provider knee) |
| $0.10 | 0.71/s |
| $0.20 | 0.25/s |
| $0.50 | 0.06/s |

**Clearing price: $0.356/job** → demand 0.106/s, served within the 30s p95
SLO by 4 providers (binary-searched, then verified on 3 fresh seeds with a
10% safety margin — the price clears robustly, not just on the search seed).

### Reading this honestly

- At the $0.05/job price point, this demand curve wants **~60 providers**
  (2.0 / 0.132 × 4) to stay SLO-clean. The binding constraint is demand, not
  supply — exactly the thesis in the master synthesis.
- The curve's level (2.0 jobs/s at $0.05) is a guess. The curve's *shape*
  (elasticity 1.5) is a guess. Both must be replaced with measured numbers
  before any pricing decision. What the simulator contributes is the
  machinery: once you have two (price, observed λ) points, fit elasticity,
  re-run `clearingPrice()`, and read off the price or the provider count.

## Capacity triggers (recommended)

Do not run providers past 70% offered load — the cliff starts well before
100%:

1. **Scale-out trigger:** p95 wait > 20s over a rolling hour → add provider
   capacity (or raise price toward the clearing price).
2. **Price trigger:** sustained offered load > 70% for 24h → recompute the
   clearing price from the last 7 days of (price, λ) observations.
3. **Shed trigger:** queue wait > 300s → new jobs get a "busy, try again"
   response instead of joining a doomed queue (abandonment is lost demand
   *and* bad UX; explicit shedding is honest).
4. **Scale-in trigger:** offered load < 30% for 72h → release capacity or
   lower price to buy demand.

## Calibrating the demand curve (procedure, no taps needed to start)

1. Log (price, observed λ) continuously — the metering layer (task #21) already
   records per-job timestamps; λ is free.
2. You need price *variation* to fit elasticity: run 2-week price experiments
   (±20%) on a traffic slice, or use the launch promo / price change history.
3. Fit log λ = a − e · log(price) by least squares; e is the elasticity.
4. Re-run `clearingPrice()` monthly; alert when the clearing price drifts
   >15% from the listed price.

## Simulator API

- `simulate({ providers, arrival, service, durationSec, seed, maxQueueWaitSec })`
- `findSaturation({ providers, service, sloSec, seed, durationSec })` — sweep λ until p95 breaches SLO
- `clearingPrice({ providers, service, demand: { baseLambda, basePrice, elasticity }, sloSec, seed })`
- `demandAtPrice({ baseLambda, basePrice, elasticity, price })`

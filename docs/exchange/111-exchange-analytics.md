# Exchange Analytics Spec (hard task 111)

Metrics for the bounty exchange + a mock dashboard with synthetic data
(`scripts/exchange/analytics-dashboard.mjs`).

## Metrics

| Metric | Definition | Why it matters |
|---|---|---|
| Bounty fill rate | % of funded bounties that reach `paid`/`resolved_paid` | Demand health; <50% means mispriced or underspecified |
| Time-to-complete | median funded→paid duration | Velocity; spikes mean reviewer bottlenecks |
| Time-to-first-claim | median funded→claimed duration | Discoverability (feeds task 114) |
| Reviewer agreement | % of reviews where advisory verdict matched the final decision | Reviewer quality signal (feeds task 108) |
| Dispute rate | % of paid-path bounties that went through `disputed` | Conflict health; >15% means criteria are unclear |
| Credit velocity | total credits moved / epoch | Economic activity |
| Reviewer latency | median submit→advisory-verdict duration | Feeds the review-timeout policy (112) |
| Abandon rate | % of claims ending in `release_claim`/timeout | Contributor fit |
| Repeat sponsor rate | % of sponsors posting >1 bounty | Retention |
| Review budget burn | review+dispute costs as % of escrow | Must stay under the 25% cap (103) |

## Dimensions

Every metric slices by: epoch, bounty category (template), bounty size
bucket, sponsor, reviewer. No per-user public leaderboards in v1 —
aggregates only, to avoid turning metrics into a status game before
reputation (108) exists.

## Mock dashboard

`node scripts/exchange/analytics-dashboard.mjs` generates 6 epochs of
synthetic data and prints the dashboard. In production these numbers come
from the ledger journal (101) + the bounty lifecycle history (102).

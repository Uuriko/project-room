# Provider Cost Breakdown Model (200-hard-tasks #28)

Unit economics per provider Mac at 2×$49/mo revenue. Model:
`scripts/provider-cost-model.mjs`
(`node scripts/provider-cost-model.mjs --csv research/provider-cost-sensitivity.csv`;
override inputs with `COST_INPUTS='{"tokensPerSec": 60}'`).
Spreadsheet: `research/provider-cost-sensitivity.csv` (±50% per input,
both margin and cost/job rankings). Tests:
`tests/provider-cost-model.test.js` (5 tests).

**Assumption (stated):** "2×$49 pricing" = two $49/mo subscription slots
per provider Mac → $98/mo revenue, flat regardless of jobs served.

## Base case (per Mac per month)

| line | value |
|---|---|
| revenue | $98.00 |
| electricity (45W delta × 12h/d × $0.30/kWh) | −$4.86 |
| hardware amortization ($0.16/h × 360h) | −$57.60 |
| **margin** | **+$35.54 (36.3%)** |
| effective throughput | ~155 jobs/h → ~55,771 jobs/mo |
| cost per job | $0.0011 |

## Sensitivity: what dominates margin (±50% per input)

| rank | input | max margin swing |
|---|---|---|
| 1 | revenue ($/mo) | $49.00 |
| 2 | serving hours/day (utilization) | $31.23 |
| 3 | hardware amortization ($/h) | $28.80 |
| 4 | electricity (wall power) | $2.43 |
| 5 | electricity ($/kWh) | $2.43 |
| 6–9 | tokens/job, throughput, overhead, jitter | $0.00 |

**Reading:** under flat subscription revenue, margin is a fixed-cost
game — revenue level, utilization, and hardware cost decide it.
Electricity is a footnote ($2.43 swing vs $28.80 for hardware).
Throughput variables don't move margin at all: they change how many jobs
the fixed cost is spread over, not the cost itself.

## Sensitivity: what dominates cost/job

| rank | input | max cost/job swing |
|---|---|---|
| 1 | throughput (tok/s) | 100% |
| 2 | tokens per job | 50% |
| 3 | hardware amortization | 46% |
| 4 | jitter (p99/p50) | 12.8% |
| 5 | orchestration overhead (ms/job) | **<1% — negligible** |

**Reading:** cost/job is a throughput game. And the task-29 finding
carries over: 7.4ms of orchestration overhead against ~19s of inference
per job is economically invisible (<1% swing). Don't optimize the
gateway to save provider margin — optimize tokens/sec.

## Implications

1. **The business is utilization, not efficiency.** The difference
   between a Mac serving 6h/day and 12h/day ($31 margin swing) dwarfs any
   power optimization. Fill the box.
2. **Hardware choice is the cost lever.** A cheaper or longer-lived Mac
   moves margin 12× more than shaving watts. Buy for $/tok/s, not W.
3. **Jitter matters more than overhead.** p99/p50 moves cost/job 12.8%
   (latency-sensitive jobs burn capacity); orchestration overhead moves
   it ~0%. Fix tail latency before gateway microseconds.
4. **Break-even:** margin goes negative if revenue drops 36% (to ~$63/mo)
   or utilization halves at current hardware cost — the two numbers to
   watch on the dashboard (task #33's SLA mock should track them).

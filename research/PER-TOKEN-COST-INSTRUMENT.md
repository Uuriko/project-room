# Per-Token Cost Instrument Spec (200-hard-tasks #27)

Step-by-step measurement protocol for the two blueprint numbers, as a
procedure John can run later on a real provider Mac. Instrument script:
`scripts/measure-token-cost.sh` (macOS, needs sudo for powermetrics).
Results template: `research/token-cost-results-template.csv`.

## The two numbers

1. **Tunnel stability** — can a provider Mac hold a usable tunnel for a
   full session? Measured as: uptime %, p50/p99 tunnel latency, reconnect
   count over a 10-minute window at 10s cadence.
2. **Per-token cost vs cheapest commodity API** — fully-loaded cost per
   1K tokens on the Mac (electricity for the *delta* power + amortized
   hardware) divided by the cheapest commodity API price for a comparable
   model.

## Protocol

### Setup (once per Mac)

```bash
# 1. Record the machine:
system_profiler SPHardwareDataType | grep -E "Model|Chip|Memory"
sw_vers -productVersion

# 2. Set the electricity rate ($/kWh) from the power bill:
RATE=0.30   # Bay Area residential, PG&E E-TOU-C off-peak ≈ $0.30

# 3. Hardware amortization: (purchase price) / (3 years × 365 × 24 h).
#    Example: $3,500 MacBook Pro / 26,280 h ≈ $0.133/h.
#    Add 20% for the share of the machine dedicated to serving:
HW_PER_HOUR=0.16

# 4. Cheapest commodity API price for a comparable model (check live):
#    e.g. DeepSeek/Qwen-class via commodity providers, $/1M tokens → /1000.
COMMODITY_PER_1K=0.0015
```

### Run 1 — idle power baseline (5 min)

```bash
sudo powermetrics -n 300 -i 1000 --samplers cpu_power -o /tmp/idle.txt
# mean CPU Power (mW) → IDLE_W
```

Machine on, no inference, screen off, tunnel connected but idle.

### Run 2 — inference under load (30 min)

```bash
sudo ./scripts/measure-token-cost.sh <model-id> 30 results-<model>-<date>.csv
```

- Fixed prompt (128-token completion cap), back-to-back requests.
- The script logs per-request tokens/sec and captures load power.
- **Sampling window: 30 minutes minimum.** Shorter windows are dominated
  by thermal ramp; the M-series chips throttle after ~10 min sustained.

### Run 3 — tunnel stability (10 min, can overlap Run 2)

The script's phase 3 pings the tunnel endpoint every 10s for 10 minutes:
60 samples → uptime %, p50 latency, reconnect count (a reconnect = a
failed sample followed by a successful one).

### Compute

```
delta_W      = LOAD_W - IDLE_W            # watts attributable to inference
elec_per_h   = delta_W / 1000 × RATE      # $/h
total_per_h  = elec_per_h + HW_PER_HOUR   # fully-loaded $/h
tokens_per_h = mean_tokens_per_sec × 3600
cost_per_1k  = total_per_h / tokens_per_h × 1000
ratio        = cost_per_1k / COMMODITY_PER_1K
```

**Pass criterion (blueprint):** `ratio < 1.0` — the Mac produces tokens
cheaper than the cheapest commodity API — **and** tunnel uptime ≥ 99%.

## Worked example (illustrative — replace with measured values)

| input | value |
|---|---|
| mean tokens/sec | 42.1 |
| delta power | 14.3 W |
| electricity | $0.30/kWh → $0.0043/h |
| hardware amortization | $0.16/h |
| total | $0.164/h |
| tokens/hour | 151,560 |
| **cost per 1K tokens** | **$0.00108** |
| commodity API per 1K | $0.0015 |
| **ratio** | **0.72 — PASS** |

## Controls & pitfalls

- **Thermal:** run the 30-min window twice; if run 2 is >10% slower than
  run 1, the chip is throttling — note it, don't average it away.
- **Background processes:** quit browsers/IDEs; check `top` for strays
  before Run 1.
- **Power source:** run on AC, battery ≥ 80% — macOS throttles on low
  battery regardless of settings.
- **Model comparability:** compare against the commodity API's *same
  model class* (e.g. 8B instruct vs 8B instruct), not against a frontier
  model.
- **Tunnel vs inference:** measure tunnel stability on an otherwise-idle
  tunnel first (isolates network), then under load (isolates contention).
- **powermetrics needs sudo** and the machine must not sleep:
  `sudo pmset -a disablesleep 1` for the run, restore after.

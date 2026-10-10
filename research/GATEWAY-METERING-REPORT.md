# Gateway-Side Metering Report (200-hard-tasks #21)

Prototype: `server/gateway-metering.mjs` — wraps a compute-kit-style inference
function, tokenizes prompt + completion locally with the real tokenizer
(`server/tokenizer.mjs`, task #22), and records metered counts alongside the
provider's reported usage. Divergence = (reported − measured) / measured.

## Experiment

20 seeded fixture jobs (varied prompts/completions), three mock providers:

| provider | jobs | flagged (>2%) | mean |Δ| | max |Δ| |
|---|---|---|---|---|
| honest but naive (whitespace word count) | 20 | 20/20 | 8.8% | 12.2% |
| under-reporting (−25% skew) | 20 | 20/20 | 31.8% | 34.7% |
| over-reporting (+40% skew) | 20 | 20/20 | 27.6% | — |

Sample rows (under-reporting provider):

| job | measured (BPE) | reported | divergence |
|---|---|---|---|
| job-alpha | 49 | 32 | −34.7% |
| job-bravo | 60 | 41 | −31.7% |
| job-charlie | 65 | 45 | −30.8% |

## Findings

1. **Naive counting is not metering.** Even the "honest" provider — one that
   counts whitespace-separated words without malice — diverges 8.8% on
   average from real BPE token counts. Any billing or $0.05/job viability
   math built on provider word counts is wrong by ~9% before anyone cheats.
2. **Skew is trivially detectable.** A −25% under-report lands at −32% mean
   divergence against the meter; a +40% over-report at +28%. A 2% flag
   threshold separates all three classes with zero false negatives on these
   fixtures — though see (3).
3. **Threshold tuning needs real traffic.** The honest-naive provider also
   trips a 2% threshold (it *is* wrong, just not malicious). Production
   thresholds should be set per model family from measured honest-provider
   baselines, and the report should distinguish "wrong method" (stable ~9%
   bias) from "drifting" (divergence that moves over time = the cheating
   signal).
4. **Cost.** Metering adds one extra tokenization pass per job: ~200K+
   tokens/sec steady-state (see research/TOKENIZER-BENCHMARK.md) — negligible
   next to inference latency.

## What's next

Wire `createMeteredGateway` around the real gateway inference path, persist
the ledger (currently in-memory), and build the per-provider divergence
dashboard from `report()`. The `divergenceOf` seam is where canary sampling
(task #23) plugs in: metered-vs-reported divergence is the cheap always-on
signal; canary re-execution is the expensive ground-truth check.

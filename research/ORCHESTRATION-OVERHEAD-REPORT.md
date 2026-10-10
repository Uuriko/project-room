# Orchestration Overhead Report (200-hard-tasks #29)

Harness: `scripts/measure-overhead.mjs` — a mock gateway pipeline
(queue → route → authorize → meter → sign → dispatch) run at concurrency
1/10/100 over 200 jobs (seed 5). Metering uses the REAL tokenizer
(`server/tokenizer.mjs`, cl100k); signing uses REAL Ed25519
(`server/bounty-receipts.mjs` signBytes); authorize/dispatch are mock
timed stages (0.5–2ms / 1–4ms). 5-job warmup before measurement; cold
start reported separately.

## p50 / p99 overhead per job (ms)

| stage | c=1: p50 | c=1: p99 | c=10: p50 | c=10: p99 | c=100: p50 | c=100: p99 |
|---|---|---|---|---|---|---|
| queue | 0.001 | 0.042 | 0.000 | 0.005 | 0.000 | 0.005 |
| route | 0.011 | 0.059 | 0.006 | 3.484 | 0.004 | 6.198 |
| authorize | 1.369 | 23.318 | 6.781 | 65.909 | 176.620 | 303.380 |
| meter (real BPE) | 0.042 | 1.314 | 0.031 | 7.474 | 0.030 | 9.157 |
| sign (real Ed25519) | 0.372 | 10.585 | 0.214 | 20.655 | 0.187 | 24.856 |
| dispatch | 3.124 | 30.371 | 14.591 | 65.149 | 123.785 | 303.372 |
| **total** | **5.409** | **55.810** | **27.319** | **88.535** | **316.924** | **345.562** |

Cold start (rank data load + regex compile + keygen, one-time per process):
**~1.4s** — a gateway startup cost, not a per-job cost.

## Top-3 overhead sources

| concurrency | #1 | #2 | #3 |
|---|---|---|---|
| 1 | dispatch 3.86ms (52%) | authorize 2.58ms (35%) | sign 0.80ms (11%) |
| 10 | dispatch 17.8ms (56%) | authorize 11.9ms (37%) | sign 1.86ms (6%) |
| 100 | authorize 149ms (50%) | dispatch 144ms (49%) | sign 2.13ms (1%) |

## Findings

1. **Steady-state per-job overhead is ~7.4ms at low concurrency**
   (dispatch + authorize + sign). Metering with the real tokenizer costs
   0.04–0.09ms warm — tokenization is *not* an overhead concern.
   Receipt signing (Ed25519) costs ~0.4ms p50 — cheap enough to sign every
   job.
2. **CPU-bound stages on the event loop inflate everything at high
   concurrency.** At c=100 the mock 1–2ms authorize/dispatch stages measure
   144–149ms — not because they got slower, but because the synchronous
   BPE + Ed25519 work across 100 workers starves the event loop and delays
   every timer callback. The harness runs crypto/tokenization on the main
   thread, as a naive gateway would. **Production implication: move
   signing and tokenization to worker threads** (or batch them); otherwise
   tail latency at high concurrency is dominated by event-loop contention,
   not by the stages themselves.
3. **Queue wait is negligible in this design** (p99 < 0.05ms at all
   concurrencies) — the worker pool never starves; the bottleneck is CPU
   contention, not scheduling.
4. **Cold start is a deployment consideration**: ~1.4s to load rank data
   before the first job meters. Warm the tokenizer at gateway boot, not on
   first request.

## What to fix first (in order)

1. Worker-thread (or native async) Ed25519 signing + tokenization — removes
   the c=100 contention blowup, the largest overhead term under load.
2. Cache + batch the authorize check (it is 35–50% of overhead and mostly
   a repeated lookup).
3. Keep dispatch async with connection pooling; the mock 1–4ms hop is the
   floor — real network will dominate, so measure it against live providers
   (task #39's latency methodology).

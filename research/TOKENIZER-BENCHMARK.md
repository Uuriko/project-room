# Tokenizer Benchmark (200-hard-tasks #22)

Measured 2026-10-07 on the lane VM (Node 24.20.0), pure-JS BPE with vendored
rank data, no dependencies. Method: `benchmark(text, family, rounds)` —
warmup pass, then 5 rounds over a 60KB prose sample (README.md) and a code
sample (tokenizer.mjs ×20), timed with `process.hrtime.bigint()`.

| family | models | prose tok/s | code tok/s | notes |
|---|---|---|---|---|
| cl100k | GPT-4, GPT-3.5-turbo | 551,215 | 309,930 | fastest; simplest regex |
| o200k | GPT-4o family | 219,859 | 269,870 | heavier split regex (~9× split cost vs cl100k) |
| gpt2 | GPT-2, GPT-3 (r50k-style) | 228,305 | 411,300 | |

Rates include a bounded (50K-entry) piece cache; first-encode of cold text is
slower (cl100k ~60K tok/s, o200k ~9K tok/s on prose) because the BPE merge is
O(pieces × pairs) per regex piece. Steady-state re-encoding — the metering
path's actual workload, where prompts repeat — is 200K+ tok/s on all families.

## Reference agreement

36 fixture cases (prose, code, CJK, emoji, whitespace torture, numbers,
markdown, special-token-looking text, 5K-char repetition, contractions) × 3
families compared against js-tiktoken (reference port of OpenAI tiktoken:
cl100k_base, o200k_base, r50k_base), special tokens disabled on both sides:

**worst divergence: 0.000%** — exact match, comfortably inside the 1% bar.

## Suitability for gateway metering (task 21)

A 2,000-token job meters in well under 100ms steady-state on every family.
Cold-encode of a 2K-token prompt on o200k is the worst case (~0.2s) and still
negligible next to inference latency. The piece cache is bounded and cleared
at 50K entries, so long-running gateway processes cannot grow it without
limit.

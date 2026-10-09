# Fuzz + load findings (guild-11)

15 units (f01–f15), all PASS. Every unit ran against a pristine snapshot of
the slice; every input had a timeout; no hangs, no uncaught exceptions.

## Unit results

| unit | target | result |
|---|---|---|
| f01 | validate.mjs hostile corpus (197 inputs) | 0 crashes, 152 pass / 45 fail-as-designed |
| f02 | validate.mjs 50MB finding | exits 1, no hang (~1.1s) |
| f03 | build-dashboard-data.mjs corrupt JSONL line | throws, names line 2, no partial write |
| f04 | build-dashboard-data.mjs 100k lines | 4.7s, 12MB findings.json |
| f05 | collect.mjs hostile events (null/non-string/huge bodies) | summary line, findings.jsonl stays parseable, only valid findings collected |
| f06 | collect.mjs duplicate ids | idempotent across reruns |
| f07 | recordCommandOutcome scaling | **PERF FINDING (below)** |
| f08 | gaugeStatus threshold edges (15 cases) | all match documented contract |
| f09 | pruneWindows 500k-entry backlog | prunes in one tick, gauge decays to ok |
| f10 | collect() with throwing store | never throws, keeps last values |
| f11 | collect() with throwing monitor | never throws, keeps last values |
| f12 | 10 parallel same-signal deliverWakePing | exactly 1 journal row, 9 flagged duplicate:true |
| f13 | gauges.mjs fresh import | all numeric, no false trip at boot |
| f14 | submit.mjs 10 hostile argv cases | all exit nonzero, nothing written |
| f15 | submit.mjs happy path | writes 1 line, tb- id shape, validate.mjs PASSes it |

## PERF FINDING: recordCommandOutcome is super-linear

`recordCommandOutcome()` recomputes the silent-timeout ratio with
`commandOutcomes.map(...)` over the FULL 15-minute window on EVERY call
(server/tripwires.mjs). Measured (f07):

- 1,000 records: 166ms
- 5,000 records: 1,041ms (6.3x for 5x records)
- 20,000 records: 29,898ms (28.7x for 4x records — near-quadratic)

At 20k outcomes in the window, each /commands request pays ~1.5ms+ just for
the ratio recompute, growing linearly with window occupancy. This strains the
module's own load-bearing constraint ("a handful of in-memory counter ops"
per request). Repro: `.tmp/units/f/f07.mjs` (node .tmp/units/f/f07.mjs).

Suggested fail-first regression: assert recording N outcomes costs < k*N
for N in {1k, 10k} (i.e. amortized O(1)); fix by keeping running
timeout/total counters instead of re-mapping the window.

Severity: latent — the 15-minute window bounds n, and realistic /commands
volume keeps per-request cost sub-millisecond. Not posted as BUG CONFIRMED
(the BUG CONFIRMED flow is mutant-scoped); recorded here for the parent.

## Endpoint robustness (r09)

GET /api/health/tripwires: POST/PUT/DELETE -> 405, unknown path -> 404,
8000-char query -> 200 (query ignored, correct), encoded %2e%2e traversal ->
200 (normalizes onto the same safe route; routing behavior is
server/http.mjs's, out of slice). Never 500 on any hostile input.

# Guild-08 test hardening — findings

Slice: 126 test files matching *claim* or *room* in tests/ (guild 09 owns the rest).

## Baseline (H01–H16)
All 126 files run in 16 batches with worktree-local TMPDIR and installed deps.
**925 tests, 0 failures, 0 cancelled.** (Two .sh suites run under bash separately.)

Note: an early run without `node_modules` produced file-level import failures
(`Cannot find package 'yaml'`); those were environmental, not test failures.
Re-ran clean after `npm ci`.

## Static weak-assertion scan (all 126 files)
8 tests flagged with zero detected assertions. Manual review: **all 8 are scanner
artifacts** — assertions live in helper functions (`throwsCode` wrapping
`assert.throws`) or the naive brace-matcher broke on regex/template-literal
content. **0 real assertion-free tests found.**

## Deliberate-break fail-first checks (H17–H20 + re-breaks)
20 suites, one surgical break each in a scratch worktree, expecting RED.
**Hardened: 20. False positives: 0.** Six initial breaks were badly aimed
(off the suite's exercised path); all six went RED on correctly-aimed re-break.
No suite stayed green under a behavior break on its covered path.

## Fail-first regressions added (from mutation survivors)
4 boundary tests added, each verified to fail with its mutant and pass clean:
- tests/claim-settle-1526.test.js: "B2-boundary — lease expiring at exactly nowMs is lapsed"
- tests/work-claim-guards.test.js: "a human with only accept_work may write work claims"
- tests/claim-overlaps.test.js: "claim expiring at exactly the query instant is not active"
- tests/room-mcp-auth.test.js: "MCP request ids of exactly 128 chars are accepted"

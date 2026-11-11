# Verified work-read scope for allowance accounting

Baseline: `0477aa4d7d4772c1ab3f1588effb43c054c6f602`. Causal red: `3d25a9348`. Runtime and controls: `6339856b1`.

The complete allowance fold now shares one synchronous verified head/schema scope, retaining independent per-work reference/body/hash/revision checks and fresh original per-item budgets. The existing receipt cache remains bounded to four envelopes and expires with the transaction. The head and exact owned schema are re-admitted before returning; head changes, schema changes, asynchronous callbacks and escaped callbacks refuse. The exposed head/counts are immutable and equality uses a private captured hash. Public single-work read behavior is unchanged. No aggregate, schema, grant or cross-transaction cache was introduced.

## Same-fixture measurement

`measure.mjs ROOT` copies the exact baseline fixture and measures the ledger fold alone twice; fixture construction, authentication, authority and priced dispatch are excluded. Both versions read every work body and preserve committed120 cents plus the held/committed ledger semantics.

| Work | Before wall ms | After wall ms | Prepared executions before → after | Returned rows before → after | Serialized result bytes before → after |
|---:|---:|---:|---:|---:|---:|
| 3 | 2.22–2.62 | 1.14–1.65 | 53 → 34 | 335 → 180 | 147791 → 75990 |
| 43 | 18.47–19.88 | 2.33–2.60 | 661 → 238 | 3741 → 462 | 2322769 → 145687 |
| 500 | 209.53–220.14 | 18.60–25.75 | 7544 → 2559 | 42586 → 3669 | 28388918 → 801686 |

Ledger-only schema catalog calls at500:502→3. Whole charge-route regression:508→9; its bound10 permits authority checks and mandatory closing re-admission. The red proves the prior per-item setup amplification. These are Node SQLite wall-clock samples, prepared executions, returned rows and JSON-serialized statement results: not Worker CPU, physical SQLite rows, IO or bind bytes. No Native qualification is claimed. The fold still reads500 bodies and remains O(all work), so this does not establish constant-cost accounting.

## Correctness evidence

Final affected neighborhood:30/30 tests pass (normalized spend, allowance, grant races, reaper/commit, original pricing). Controls cover500-work held/committed accounting, reservation rollback, corrupt/missing proofs, cross-transaction receipt freshness, head mutation rollback, owned-index mutation rollback, callback escape and async rejection. Targeted lint:0 errors,3 pre-existing current-room-repository raw-member warnings. Whole-tree secret scan:1889 files,0 findings.

The compressed red/test/lint logs and before/after JSON retain exact local results. No live calls, deployment or provider charges were made. Runtime source has not changed after6339856b1.

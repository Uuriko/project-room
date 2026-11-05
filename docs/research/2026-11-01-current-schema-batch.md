# Exact audit schema batching

Runtime `8b56372d2` on root `2dbf1f547`. The other laptop's SMALL-SEAM at `d83157557539d831e90fdf369321cd794209a3a6` identified catalog cost. Its 373 catalog calls / 241,282 physical reads included other verifiers; its separate dominant DROP TRIGGER lifecycle is not fixed here.

The candidate validates the same original 49 audit-owned definitions in one cold query. A per-database WeakMap stores row locations only. Every invocation rereads the full expected set and checks cardinality, exact name, normalized SQL and warm rowid/name binding. A mismatch refuses and clears hints. The exact closed writer permit is checked unconditionally. Controlled restore guard replacement invalidates both serving and audit location hints.

Actual production Native ProjectRoom, direct verifier invocation after construction, identical catalog in both arms:

| Call | Original statements / physical reads | Candidate statements / physical reads |
|---|---:|---:|
| Cold | 50 / 42,484 | 2 / 868 |
| Warm | 50 / 42,484 | 2 / 99 |
| Persisted object, cold restart | 50 / 42,484 | 2 / 868 |

Every call still reads and checks 23,784 bytes of SQL definitions and requires one closed-permit query. Zero physical writes and zero unknown counters were observed. Constructor cost, CPU and whole restore totals are outside this measurement. Baseline aliases only the original verifier module; production Native/store/catalog remain the same. This uses an empty initialized Native database, not a claim of full-room scale qualification.

Node controls cover missing guards, changed SQL, equal-count substitution, table replacement, exact DDL at a changed rowid, warm open-permit refusal, rollback, explicit invalidation and legitimate restore suspension/reinstallation. Four existing attachment controls retain old-format warm/cold read/write/prepared-DML refusal. Native controls add changed-SQL refusal with warm and explicitly invalidated cold verification, exact repair, and independent unknown global writer refusal. Extra global writer inventory remains the existing full verifier's responsibility.

Qualification: 8 Node tests pass; new Native comparison passes; existing actual Native recovery engine and full-schema writer-fence checks both pass. Targeted ESLint has zero errors and one pre-existing raw-members warning at repository line 873.

Commands use Node 24 and the installed MINIFLARE_WORKERD_PATH:

- `node --test tests/current-schema-batch.test.mjs tests/current-browser-attachments.test.mjs`
- `node --test cloudflare/current-schema-batch-native.check.mjs`
- `node --test cloudflare/recovery-engine-native.check.mjs cloudflare/writer-fence-metadata.check.mjs`

Logs: `/tmp/current-schema-batch-node-red.log` (baseline causal failures), `/tmp/current-schema-batch-node-first.log`, `/tmp/current-schema-batch-native-first.log`, `/tmp/current-schema-batch-native-regression.log`, `/tmp/current-schema-batch-lint.log`. Machine-readable measurements: `audit/evidence/current-schema-batch-20261101.json`.

Offline schema 45 only. No deployment or live activation.

# Report-1 bounded fingerprint component (not a serving activation)

Source component: `5b22375ee32c8536d7c0f7b9536742a95029429c`, based on `6b619981d8e8360a2cd3ceb1dd4cbd40a335280a`.

Eight focused Node/SQLite controls and one actual Native SQLite component check pass. The production final oracle remains mandatory and unchanged. This component is not yet called by restore. It does not qualify production source canonicalization, authority, full recovery, or deployment.

## Exact byte behavior

The original oracle canonicalizes each row, sorts canonical **strings using JavaScript UTF-16 order**, then hashes the canonical JSON array of those strings. SQLite BINARY ordering is not equivalent for supplementary codepoints; a differential control preserves this counterexample. The component stages canonical strings in 8,192 UTF-16-unit chunks, keyed by fixed 16-digit row ordinals plus part. Two reused generations of ordinal-only references implement bottom-up, two-way external merge. Comparisons resume across equal chunks. No SQL sorts a payload, and no index contains an entire canonical row. Equal values retain separate references and counts.

The hash feeds `[` / commas / JSON-quoted row strings / `]` into existing `replay-sha256`. A trailing high surrogate is carried across chunk boundaries before quoting. Per-table results retain original applicationTables order for exact dataSha256. Independent whole-oracle tests cover Unicode, lone surrogates, actual high-surrogate chunk splits, duplicates, number formatting, object-key ordering, nested values, empty tables, long equal prefixes and large cells.

The component enforces exact control keys, run boundaries, pointer/output relations, addressed part presence, hash-row limits and completed digest equality with the persisted hash cursor. It is **not an authenticator**: an attacker who can replace both hash state and matching digest can forge them. The owner must protect and bind the entire cursor/input inventory through the existing restore transaction and sealed source. The source encoder must provide actual `canonical(row)` bytes; this helper intentionally does not accept whole arbitrary rows or pretend a materializing codec is streaming.

## Explicit T0 snapshot contract required before integration

Literal live report1 includes both `current_restore_admission` and `current_restore_audit_scratch`. Continuation writes change both. Tests demonstrate this self-input problem. No rows are silently omitted by the production oracle.

The proposed restore-only basis is an actual T0 database instant **after all semantic/engine phases, pending / audit_pending / full_audit_pending, with scratch SQL-proven empty**. Capture in the SAME privileged transaction before the first report workspace/checkpoint write:

- The exact raw admission row: singleton, state, restore_id, phase, revision, source_seal, coverage, latest_receipt. Preserve SQL NULL versus text, and the exact original TEXT bytes. Do not parse and reserialize nested JSON fields.
- Exact restoreId, source seal, revision, applicationTables inventory/order, schema/guard identity, and the closed raw tuples of current_room_writer_permit and public_work_claim_writer_permit.
- A protected digest and part inventory of the target-generated capture. The existing scratch/chunk representation can hold bounded pieces; it is not a user-supplied report view.

Every step and final verification must revalidate the source seal, restore/phase authority, exact guards, same immutable original capture binding, and **closed, unchanged writer-permit tuples**. Report progress may change current admission control, but cannot mutate its captured T0 bytes. Other business rows remain under the existing sealed-source writer fence. No unrelated operational table is excluded.

Only an explicitly named restore-specific report view substitutes **the captured admission row and the proven-empty T0 scratch rows**. Every other applicationTables row, count and duplicate remains included. Default auditRecovery stays literal. The differential reference must invoke the original oracle at T0, or the same explicitly declared T0 view later. It cannot claim equality with the later live database containing report workspace.

The executable T0 contract fixture proves raw-whitespace preservation, exact binding changes rejected (control, seal, restoreId, revision, inventory and permits), protected business writes refused, and a fault-injected business change detected by the independent oracle. This is a **contract fixture, not a production restore-authority integration proof**.

## Atomicity, recovery and remaining implementation

The owner must atomically commit scratch writes, the exact new cursor and the normal immutable request receipt under existing CAS. A helper call alone is not a lost-ACK protocol: reapplying an old merge cursor after a committed later pass may read an overwritten index generation. Existing exact request receipt retry must return the original result instead. The SQLite rollback control proves interrupted component writes roll back, then serialized original control resumes to the exact digest. Actual Native restarts the isolate mid-sort with control persisted in SQLite. Actual lost-ACK production restore integration remains unqualified here.

Remaining consumed implementation: a bounded, platform-correct source row canonical encoder (including large SQL atoms, numeric and BLOB driver semantics); privileged T0 capture and immutable binding/chunk storage; report phase ownership/CAS/exact-ACK integration; restore-specific whole-oracle differential comparison with that same T0 view; final scratch cleanup of snapshot/workspace after verified result. Do not add this component as an ignored precheck or remove the final oracle early.

## Measured Native component cost

Both workloads contain two 160 KB cells. Each step is 16 comparison/output or hash units. The fixture uses actual Native SQLite and scalar byte admission before addressed payload reads. It excludes constructor DDL, source ingestion/canonicalization, test control-row reads/writes, restore guards, receipt maintenance and all production endpoint work.

| Rows | Calls | Max statements | Max rows read | Max reported rows written | Max materialized JSON bytes | Total rows read | Total reported rows written |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 64 | 32 | 176 | 336 | 32 | 266,354 | 7,444 | 448 |
| 512 | 324 | 176 | 336 | 32 | 266,354 | 86,858 | 5,120 |

Cumulative comparisons and writes grow with rows and equal-prefix lengths; bounded per-visit work does not mean less total work or constant installation/storage cost. The first provisional 160-statement guard failed and is retained. The corrected 176 bound is source-derived: each of 16 merge units can issue three ordinal reads plus two chunk reads, each scalar/payload pair, and one write = 11 statements. These cursor counters are not CPU, universal storage IO or a production SLA. Payload bytes mean serialized returned rows, not heap or stored size. Final fixture-only whitespace was Acorn-AST equivalent; no Native rerun was needed for that formatting.

## Reproduction

```
/Users/johnpotter/.local/bin/node --test tests/recovery-report-continuation.test.mjs
/Users/johnpotter/.local/bin/node --test cloudflare/recovery-report.check.mjs
/Users/johnpotter/.local/bin/node scripts/lint.mjs
/Users/johnpotter/.local/bin/node scripts/secret-scan-check.mjs
```

Full logs and digests are alongside this note. No runtime stitch, push, deployment, production calls or release approval occurred.

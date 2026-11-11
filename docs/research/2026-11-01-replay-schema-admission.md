# Supported schema admission investigation

The repeated eight sqlite_master scans were measured in the actual October Worker. The proposed connection-scoped schema_version cache passes the five Node controls but cannot be used in Durable SQLite: `PRAGMA schema_version` returns `not authorized: SQLITE_AUTH`.

The preserved statement sequence is synthetic `/seed?bytes=2376000` followed by `/durable-capture`; capture enters exact schema admission and fails on the first schema_version PRAGMA, before witness copy, progress or receipt writes. There is no fallback. `/tmp/replay-source-schema-cost-first.log` preserves the error. This attempt is not a usable Worker candidate.

The supported replacement under review discovers exact object rowids at cold/explicit admission and revalidates rowid, type, name, tbl_name and exact byte-admitted SQL through indexed catalog lookups. Replacement at another rowid must refuse until explicit rediscovery. Exact same-rowid reuse after identical DROP/recreate is an explicit qualification question: final tuple equality cannot establish that no intervening DDL window occurred. It must not be claimed without a causal control. No new persistent authority or schema/default activation is introduced.

## Qualified current-definition lookup

The supported replacement uses eight cold name lookups, then eight exact `sqlite_master WHERE rowid=?` checks per step. Each check binds rowid, type, name, owning table and exact SQL. SQL byte length is compared to the code-owned expected definition length before materialization. Per-connection admission never crosses reopen/restore. Observed missing or changed tuples invalidate admission until explicit re-admission; unrelated DDL with unchanged owned tuples is accepted. Identical last-rowid reuse after DROP/recreate is explicitly accepted as current-definition equality only, never as source continuity.

The actual October Worker comparison used the same synthetic 2,376,000-byte source and two hash steps. Before this optimization (ba35a656), physical rows read were 6,347 and 6,376; after, 43 and 72. Both versions execute 48 statements and write 21 then 14 rows. Both fetch 3,541 schema-definition bytes. The prior 5fb8 path used 24 statements, 6,331 reads and 5 writes, but lacks the completed-root inclusion protection and is not qualified. Counters are physical runtime observations, distinct from the separate logical per-step reservation.

Runtime: workerd 2026-10-19, package 1.20261019.1, binary SHA-256 3684a329a3d598a1e5879ee3cf74d8fd88cc0ab9639905f25a305aa9e0d57ea0; compatibility date 2026-07-30. The local explicit runtime override reports valueLimitBytes 8,388,642; this does not establish production binary identity. The supported codec limit remains 4 MiB; earlier 8 MiB work is capture-only experimental.

Qualification: 99 focused Node controls (including nine schema and fourteen recovery checks), two actual Worker checks, and targeted ESLint pass. The Worker partitions 3,425,251 bytes into 17,405 message leaves and 305 reply-request entries over 600 steps; maximum observed admitted step input 108,544 bytes, leaf size 183 bytes and receipt 2,757 bytes. A later append, partial restart, historical receipt retry, and leaf/local-hash tamper refusal are covered. Results remain uncertified with publication pending.

Evidence: `/tmp/replay-schema-tuple-node-final.log`, `/tmp/replay-schema-tuple-worker-final.log`, and `/tmp/replay-source-schema-cost-supported.log`. The replay module measured in the cost comparison has SHA-256 0891c6bea1b7ce1c61c8d951f5f47cb379a9d2d9209064c62f380060d942ebf7. No default registration, schema activation, source baseline, semantic certification or serving publication is enabled.

## Separate journal continuity gap

A controlled trigger gap can mutate an old posted body which a later deletion hides, recreate every catalog tuple identically, and leave the projection witness, current serving state and strict replay result unchanged. Epoch remains zero. That is a journal provenance failure, not a failure of captured-projection chunk membership. Current-definition checks cannot close it. Hash/partition completion remains uncertified; an independently retained exact journal/prefix anchor is required before semantic adoption.

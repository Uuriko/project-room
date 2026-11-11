# Final restore audit cost — exact source 482c2766b

This is synthetic qualification of `482c2766bd771499ea4ea3b71e78b4df21ae0d35`; no production data/calls or runtime changes. The existing Native durable-coverage fixture completes useful accepted work, preserves a private reply request and history floors, strict-restores the export, cold-reopens during continuation, and refuses ordinary readiness until final verification. Its dataset has one room, two members, 1,009 events, 1,002 messages, one accepted task, one private request, and a legal 160,029-byte timestamp. **Zero invitations; no retained checkpoint.**

The inherited 400-step test guard fails before finalization at this current protocol16 source. That red is retained. A qualification-only cap of2,000 permits the same workflow to complete in496 steps, with original assertions unchanged:6,096 coverage rows,227 quick-check tables,228 foreign-key tables, exact retries, sealed prepared-writer refusal, cold ready, and message/task retry identity. Both completed measurement runs pass1/1, exit0. No continuation/runtime threshold changed.

## What was measured

Only the `audit_pending/full_audit_pending` operator request and its exact retry are counted. The fixture wraps raw `ctx.storage.sql.exec`, including maintenance calls outside the adapter. Cursor getters are sampled after consumption. A test-only synchronous `readTransaction` wrapper labels the `auditRecovery` call; all other finalization remains separate. This label refinement produces the **same native totals** as the initial successful capture. Constructor/seed/export/prechecks are excluded; the full oracle is still mandatory.

| Scope/family | Statements | Native rows read | Materialized row JSON bytes |
| --- | ---: | ---: | ---: |
| Complete final request | 15,628 | 944,950 | 6,964,984 |
| `auditRecovery` only | 14,706 | 111,003 | 6,568,397 |
| Other finalization | 922 | 833,947 | 396,587 |
| Oracle catalog checks | 44 | 67,863 | 139,148 |
| Oracle current/message census | 14,099 | 20,140 | 2,468,290 |
| Oracle exact final table fingerprints | 222 | 6,302 | 2,626,820 |
| Oracle table quick-checks | 227 | 6,309 | 4,540 |
| Oracle global foreign-key check | 1 | 6,125 | 0 |
| Oracle room history/replay | 4 | 4,036 | 968,118 |
| Exact final-request retry | 9 | 1,745 | 33,839 |

All cursor counters are available. Final request reports6 rows written, retry2. **These are cursor counters, not universal engine I/O:**666 `DROP TRIGGER` statements mutate schema while their cursors report0 rows written. SQL-result bytes count UTF-8 JSON serialization of returned values, not peak heap/storage bytes. Stack/JSON instrumentation affects elapsed time; no CPU/production latency claim.

## Actionable ranking and preserved semantics

1. **Atomic thaw is the dominant final-request cost:** `removeRestoreFreeze` (`server/writer-fence.mjs`, called by `server/restore-ndjson.mjs`) executes666 trigger drops for798,867 rows read, about84.5% of the entire request. This is outside `auditRecovery`. Root's separately measured retained-guard prototype `62f935f9880a37c6ad9fccb2584c0570a00d2378` already addresses this spike, but its peer evidence records ordinary-read/write/constructor costs; it is **not** adopted or remeasured here. A bounded operator-only cleanup after atomic verified publication could amortize these drops without a permanent catalog tax. It must bind the verified seal/format, preserve original publication receipt/retry bytes, refuse a newly pending restore, and never put DDL on ordinary reads/writes. Cumulative DDL work remains; this alone does not remove the oracle blocker.

2. **Inside the oracle, repeated catalog discovery dominates rows:**44 calls/67,863 reads. Source stacks identify Inbox.verify, Reminders.verifySchema, AgentConnections.verifyHistory, EmailImport.verify, delegation/channel/handoff/schema verification, and restore-control checks. Next narrow optimization should reuse existing exact catalog-tuple admission within the same sealed audit transaction, preserving exact SQL/type/name/table inventory and extra/partial/malformed refusal. Do not add another precheck whose output finalization ignores.

3. **The remaining release blocker is full reconstruction plus fingerprinting:** `readCurrentRoomForAudit` builds the whole protected state with14,099 point/census statements; `rebuildProjection` replays retained-checkpoint/tail or full history; recovery.mjs separately loads event history for strict event/charter/text/reply/help rules, then `applicationTables.map(SELECT *).map(canonical).sort()` materializes2.63MB and computes the legacy report digest. The next semantic patch must consume already completed independent census/replay/engine/subsystem evidence under the unchanged sealed source, rather than rerunning this global oracle. Preserve complete present/absent memberships, current row proofs, work/privacy/ancestry/history floors, exact replay/backfill/drift semantics, strict event validation, all required subsystem checks, SQLite/FK integrity, and report row-count/digest meaning. The existing sorted canonical report hash cannot silently become a row-bag hash; any report-contract change must be explicit and independently compared. Repeating engine checks is another12,434 rows despite the completed227/228-table engine continuation.

Confirmed source duplication: `auditRecovery` calls `verifyInvitationAudit`, then finalization calls it again and compares to the independent invitation continuation. This empty-invitation fixture measures only two inventory/orphan queries in each call (2+2 reads); it cannot rank a real78-invitation room. Reuse the already returned oracle invitation result if semantics align; do not claim that alone solves full recovery.

## Reproduce

Decompress `recovery-final-cost.check.mjs.gz` and `recovery-final-cost.test-fixture.mjs.gz` into the exact checkout's `cloudflare/` directory, then run:

`/Users/johnpotter/.local/bin/node --test cloudflare/recovery-final-cost.check.mjs`

Existing esbuild/Miniflare/workerd plumbing is reused; no new recovery system. Logs, source hashes, raw query/stack aggregates, phase totals and oracle-family totals are included. Default fixture has no checkpoint; two independent seeded replicas share the same legal structure, not byte-identical random IDs. No further benchmark or runtime patch was performed.

# QA Mutation Probes — ledger

Fail-first mutation probes against backup/restore parity. One row per probe.
Never re-probe a row recorded CAUGHT — the mutation is pinned by the named test.

Columns: ID · Worker · Date · Target · Mutation · Existing tests run · Verdict ·
Hardening test · Notes

| ID | Worker | Date | Target | Mutation | Existing tests run | Verdict | Hardening test | Notes |
|----|--------|------|--------|----------|--------------------|---------|----------------|-------|
| QA200-MUT-22-A | qa200-mut-22-backup-restore | 2026-10-08 | server/backup.mjs `backupRoom` | destination backup silently `DELETE FROM messages` (all rows of one non-watermark-pinned table) | tests/backup-verify.test.js, tests/room-backup-export.test.js, tests/rel14-backup-bytes.test.js — 31/31 pass with the mutation | UNCAUGHT | tests/backup-table-parity.test.js — red-with-break ("messages (source 3 rows -> backup 0 rows)"), green-without; kept | Watermark pins only `events` count + `rooms` id/sequence; REL-14 digests cover events + attachment bytes only. PR #2055 adds the parity test. |
| QA200-MUT-22-B | qa200-mut-22-backup-restore | 2026-10-08 | scripts/backup-verify.mjs `verifyRestoredBackup` | neutered `attachment-bytes-intact` check (always true) | tests/rel14-backup-bytes.test.js — "verification fails when room file bytes change at the same length" goes red | CAUGHT | — (already pinned by tests/rel14-backup-bytes.test.js) | REL-14 (Fo 3742) already ships `backupDigests` + per-attachment sha256 refusal. Probe harness also confirmed end-to-end: same-length byte corruption in the backup copy → `verifyRestoredBackup ok=false`, `FAIL attachment-bytes-intact`. |
| QA200-MUT-22-C | qa200-mut-22-backup-restore | 2026-10-08 | server/store.mjs `importEvents` (NDJSON history restore over existing data) | owner gate removed (`owner_required` 403 deleted) — non-owner silently overwrites room history | tests/room-export.test.js — "room import round-trips an export (round-2 #107)" goes red (asserts non-owner → 403) | CAUGHT | — (already pinned by tests/room-export.test.js) | Import is owner-only + transactional + validates before writing; pending invitations loss on restore is documented in code. No confirm-flag exists, but the owner gate is the explicitness mechanism and it is pinned. |

## Out of scope for this worker (per brief)

- OAuth code reuse
- spend void-after-settle
- writer-fence tamper
- permission-upgrade review()

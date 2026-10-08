# QA mutation probes

Recorded probes across the 2026-10-08 QA200 mutation wave. Rows are append-only;
never re-probe a recorded CAUGHT row — write a new row if the target changes.

Format: `| probe | target / mutation | result | worker | date | notes |`

| probe | target / mutation | result | worker | date | notes |
|-------|-------------------|--------|--------|------|-------|
| file-lease A | `fileLeaseConflicts` forced to return `[]` (declared overlaps pass undetected) | CAUGHT | qa200-mut-26 | 2026-10-08 | 4 failures across work-claim-files + work-claim-guards; tests distinguish declared vs undeclared overlap |
| file-lease B | 409 `file_lease_conflict` body stripped to generic 409 (no holder/expiry) | CAUGHT | qa200-mut-26 | 2026-10-08 | 5 failures; tests assert holder claimId/owner, conflicting files, and leaseExpiresAt |
| file-lease C | `update` allowed to change declared `files` after claim (was 422-immutable via shape) | UNCAUGHT → hardened | qa200-mut-26 | 2026-10-08 | All 16 file-lease tests passed with the break. Hardening test added: "update cannot change the declared files after claim (files are immutable)" in tests/work-claim-files.test.js — verified red-with-break / green-without. PR #2037 |

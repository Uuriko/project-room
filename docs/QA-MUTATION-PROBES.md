# QA Mutation Probes

Mutation-testing ledger for John's 200-agent QA wave (2026-10-08), mutation lane.
Workers append rows here; **never re-probe a recorded CAUGHT row** — the suite
already pins that behavior.

Columns: probe | worker | target (file) | mutation | verdict | pinning test(s) | notes.

| probe | worker | target | mutation | verdict | pinning test(s) | notes |
|---|---|---|---|---|---|---|
| qa200-mut-21-A | qa200-mut-21 (coord qa200-mutation) | server/work-claim-integrity.mjs `assertBoardEventBudget` | Gate disabled: early `return` — writes allowed past the budget floor | CAUGHT | tests/work-claim-integrity.test.js "board input rules … event budget" (`assert.throws … 409 room_event_budget_low`) | Fails red at test.js:440 "Missing expected exception". Route-level test also pins the 409. |
| qa200-mut-21-B | qa200-mut-21 (coord qa200-mutation) | server/work-claim-integrity.mjs `roomEventsRemaining` | Counter undercounts: `eventsPerRoom - floor(sequence/2)` — writes appear not to consume budget | CAUGHT | tests/work-claim-integrity.test.js "with under 10% of the event budget left…" (route) + "board input rules … event budget" (`roomEventsRemaining(limit-5) === 5`) | Both route and pure tests fail under the mutation. End-to-end counter tracking pinned by `status.eventsRemaining === limit - sequence` after real writes. |
| qa200-mut-21-C | qa200-mut-21 (coord qa200-mutation) | server/work-claim-routes.mjs call sites (lines 519/551/760) | Privilege flattened: `{ privileged: true }` for all writers at <10% budget left | CAUGHT | tests/work-claim-integrity.test.js "with under 10% of the event budget left only the owner and claim managers write" | Non-privileged `contrib` write no longer refused → route test fails. Pure unit (`privileged:false` throws, `privileged:true` passes) also pins the distinction. |

## Probes recorded by #2037

Recorded probes across the 2026-10-08 QA200 mutation wave. Rows are append-only;
never re-probe a recorded CAUGHT row — write a new row if the target changes.

Format: `| probe | target / mutation | result | worker | date | notes |`

| probe | target / mutation | result | worker | date | notes |
|-------|-------------------|--------|--------|------|-------|
| file-lease A | `fileLeaseConflicts` forced to return `[]` (declared overlaps pass undetected) | CAUGHT | qa200-mut-26 | 2026-10-08 | 4 failures across work-claim-files + work-claim-guards; tests distinguish declared vs undeclared overlap |
| file-lease B | 409 `file_lease_conflict` body stripped to generic 409 (no holder/expiry) | CAUGHT | qa200-mut-26 | 2026-10-08 | 5 failures; tests assert holder claimId/owner, conflicting files, and leaseExpiresAt |
| file-lease C | `update` allowed to change declared `files` after claim (was 422-immutable via shape) | UNCAUGHT → hardened | qa200-mut-26 | 2026-10-08 | All 16 file-lease tests passed with the break. Hardening test added: "update cannot change the declared files after claim (files are immutable)" in tests/work-claim-files.test.js — verified red-with-break / green-without. PR #2037 |

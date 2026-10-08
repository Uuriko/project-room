# QA Mutation Probes — living ledger

Fail-first mutation probes against Project Room: deliberately break the server,
run the relevant tests, and record whether the suite caught the break.

## Already probed by other workers (do NOT re-probe)

| seq | date | target file | mutation applied | test file(s) | CAUGHT/UNCAUGHT | notes |
|---|---|---|---|---|---|---|
| MUT-00-001 | 2026-10-08 | auth/oauth (code reuse) | OAuth code reuse allowed | — | SKIPPED | already probed by another worker |
| MUT-00-002 | 2026-10-08 | spend settle | spend void-after-settle | — | SKIPPED | already probed by another worker |
| MUT-00-003 | 2026-10-08 | server/writer-fence.mjs | writer-fence tamper | — | SKIPPED | already probed by another worker |
| MUT-00-004 | 2026-10-08 | permissions review() | permission-upgrade review() check | — | SKIPPED | already probed by another worker |

## QA200-MUT-01 probes (work-claim routes: create idempotency + per-identity cap)

Coordinator-reported rows (2026-10-08; workers safety-paused before full reports; mutations reverted by coordinator; trees verified clean; claims released):

| seq | date | target file | mutation applied | test file(s) | CAUGHT/UNCAUGHT | notes |
|---|---|---|---|---|---|---|
| MUT-06 | 2026-10-08 | server/bounty-receipts.mjs | MUTATION-B: `.filter(k => k !== "payload")` in canonicalJson's object branch — payload excluded from signed bytes (signature-forgery-class weakening) | — | outcome UNCONFIRMED | worker's tool use paused before pass/fail reported; coordinator reverted mutation, worktree clean |
| MUT-03 | 2026-10-08 | server/work-claim-routes.mjs | probe A: replaced `const authority = authorityOver(item);` with `const authority = true;` in the /release handler (non-owner release allowed) | — | outcome UNCONFIRMED | worker's tool use paused before outcome reported; coordinator reverted mutation, worktree clean |
| MUT-04 | 2026-10-08 | claim RENEW | (probe completed) | — | outcome UNCONFIRMED | coordinator sweep found no leftover mutation; worktree clean |
| MUT-07 | 2026-10-08 | bounty receipts | (probe completed) | — | all CAUGHT (per worker's final preview) | reported "no PR (all caught)"; worktree clean |

Claims released by coordinator: qa200-mut-03-claim-release, qa200-mut-04-claim-renew, qa200-mut-06-receipt-verify, qa200-mut-07-bounty-receipts.

| seq | date | target file | mutation applied | test file(s) | CAUGHT/UNCAUGHT | notes |
|---|---|---|---|---|---|---|
| MUT-01-001 | 2026-10-08 | server/work-claim-routes.mjs (create route) | duplicate CREATE returned 200 with the existing claim instead of 409 work_claim_exists | tests/work-claim-*.test.js, tests/claim-*.test.js, tests/public-work-claim*.test.js (existing) + tests/work-claim-idempotency.test.js (new) | UNCAUGHT | 331 existing tests stayed green with the break (incl. board/guards/duplicates/claims/client); only the env-broken yaml import in work-claim-client failed pre-node_modules-symlink. Hardening test "duplicate CREATE returns 409 work_claim_exists and leaves the claim unchanged" verified RED with break (200 !== 409), GREEN after revert. |
| MUT-01-002 | 2026-10-08 | server/work-claim-routes.mjs (create route, assignee branch) | per-identity cap check weakened to `held >= config.maxMemberOpenClaims + 1000` (cap never refuses on CREATE-with-assignee) | tests/work-claim-board.test.js, tests/work-claim-guards.test.js, tests/work-claims.test.js, tests/work-claim-duplicates.test.js, tests/work-claim-reassign-unclaimed.test.js, tests/work-claim-client.test.js (existing) + tests/work-claim-idempotency.test.js (new) | UNCAUGHT | 67 existing tests stayed green with the break. Existing cap coverage (board.test.js:140, guards.test.js:107) only pins the claim-route cap, not the CREATE-with-assignee cap. Hardening test "CREATE with assignee refuses 409 too_many_open_claims when the assignee is at cap" verified RED with break (201 accepted), GREEN after revert. |

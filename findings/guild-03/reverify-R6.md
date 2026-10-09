# re-verify R6: wave300/sharded-claim-boards
started: 2026-10-09T09:51:14Z
HEAD is now at fca324073 boards: openapi docs + keep pre-shard config shape when no boards configured
branch head: fca324073, merge-base with origin/main: cb05aa5b
slice files changed: server/work-claim-routes.mjs 
rebase: CONFLICT — aborted, testing un-rebased head
running affected suite: tests/work-claim-board.test.js tests/work-claims-read.test.js
suite: 2 passed, 0 failed
node --check on slice files:
done: 2026-10-09T09:53:45Z

## Adversarial review (2026-10-09)
Branch: origin/wave300/sharded-claim-boards.
Rebase: CONFLICT — aborted, tested un-rebased head. Suite: 2 passed, 0 failed.
- Sharded boards: namespace on claims, ?namespace= on reads (* = merge), new boards census route, per-board caps via boardCapFor, per-board config in the config route (now all-optional with an at-least-one guard — backward compatible).
- R6-1 (positive): the per-member cap stays room-wide so shard-hopping cannot evade it — the evasion was considered.
- R6-2 (advisory): file-lease conflicts are room-global (not per-board) — two claims on different boards with overlapping files still 409. Defensible (files are room resources) but note the sharding doesn't isolate file leases.
- R6-3 (positive): memoizeList cache key includes the namespace with \u0000 separator and invalidates the whole room on write — no cross-board cache poisoning.
- ?namespace= absent defaults to the default board (backward compatible); claim-scoped routes resolve across boards (ids are room-unique).
Verdict: no breakage. Well-considered; needs rebase.

# re-verify R3: wave300/fix18-cap-gapfill
started: 2026-10-09T09:47:42Z
HEAD is now at addd5eda8 wave300/fix18: expired state for lapsed leases + cap gap-fill
branch head: addd5eda8, merge-base with origin/main: b5c215f8
slice files changed: server/work-claim-routes.mjs 
rebase: CONFLICT — aborted, testing un-rebased head
running affected suite: tests/work-claim-guards.test.js tests/work-claims-read.test.js
suite: 2 passed, 0 failed
node --check on slice files:
done: 2026-10-09T09:49:31Z

## Adversarial review (2026-10-09)
Branch: origin/wave300/fix18-cap-gapfill.
Rebase: CONFLICT — aborted, tested un-rebased head. Suite: 2 passed, 0 failed.
- Lease expiry now lands items in a distinct `expired` state (in STATES, not in ACTIVE_CLAIM_STATES — verified coherent), still re-claimable via the claim route (accepts unclaimed|expired), excluded from the board cap via countsTowardBoardCap.
- New opt-in staleClaimTtlMs config (null=disabled, min 1h) retires unclaimed/expired items to closed with a stale_retired stamp — retired, never deleted. Runs in the shared request preamble (same as the existing sweep-on-read pattern), emits system-actor events.
- R3-1 (advisory): `released[]` ids in sweep/list responses now refer to items in `expired` state, not `unclaimed` — clients asserting state==unclaimed after sweep will see expired. Contract change is intentional; downstream consumers need the note.
- R3-2 (advisory): retireStaleRoom retires *unclaimed* items too — an unclaimed item idle past the TTL is closed. Documented intent, opt-in only.
Verdict: no breakage. Clean contract change, needs rebase.

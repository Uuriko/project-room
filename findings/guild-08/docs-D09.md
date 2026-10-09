# Guild-08 suite docs — D09

## work-claim-idempotency.test.js (3 tests)
QA200 mutation probe (qa200-mut-01): pins the HTTP contract that duplicate CREATEs and cap-breaking CREATEs are refused with 409, so a future regression silently accepting them (200) can't slip through. Idempotency + cap contract.

## work-claim-integrity.test.js (16 tests)
Proves SEC-2/Q3-A board integrity at the claim route with a real RoomStore: reviewers-only notes (100 notes → 1 event; 50 rapid updates → ≤2 events); sweep restricted to board writers/managers/owner (refused before any GitHub read); PR outcome/CI/head facts refused from clients; 200-entry history cap with PR-link precondition counting dropped entries; done-claim paging by age; list p95 under 50ms; event-budget low-water write restrictions; deploy status fetched at most once/60s by writers only. Integrity + budget suite.

## work-claim-leases.test.js (19 tests)
Proves claim leases, delivery modes, review policies (RC-2026-09-18-041): claimedAt + leaseExpiresAt stamped, 24h default, explicit/room-config overrides, null opt-out; isLeaseExpired only for active lapsed claims; releaseExpired auto-releases (clearing attestations); delivery modes persist on done; all three review policies enforced by canCloseWork; caller-bound attestations cleared on handoff; config hook; unclaimed registry entry; query-helper backward compat. Pure state machine + handler smoke.

## work-claim-multiprocess-race.test.js (1 test)
Multi-process claim-race stress test driving the REAL storage layer (node:sqlite, WAL, busy_timeout, BEGIN IMMEDIATE — production's exact discipline) from N separate OS processes: exactly one winner, clean 409s, consistent board. Single test, proves the race discipline end-to-end.

## work-claim-pr-link.test.js (20 tests)
Proves PR linking and settlement: draft linking preserves leases; webhook close and polled pulls reduce to the same outcomes; merged polls complete claims with room events; closing webhooks release (second delivery doesn't re-settle); batches stay claimed until all pulls resolve; explicit releases settle open batches; open pulls aren't settled (sweep waits, no re-poll); cron poll matches sweep; GitHub 403 backs off until reset; 304 keeps claims; cron deadlines don't double-call; close/cancel append validated closed events on store, REST, and MCP. PR-settlement lifecycle suite.

## work-claim-provenance.test.js (11 tests)
Proves claim provenance + rollback: parentClaimId/evidenceRefs recorded; legacy defaults backward compatible; self-parents and malformed refs rejected; provenance set/replaced/amended; walkProvenance transitive + cycle-safe + capped; flagPremiseInvalid stamps without changing work state; HTTP and MCP surfaces accept/walk/flag provenance. Provenance-graph contract suite.

## work-claim-qa-fixes.test.js (17 tests)
QA fix wave 2026-09-28 (Worker D): W1 null-lease opt-out semantics (explicit null opts out, omitted applies default, junk refused loudly, renew-with-null removes); W2 release routes through pause; W3 reassign validation (nonexistent/inactive refused, active works); W4 renew-after-lapse 409s with "claim it again". HTTP-contract regression suite from the production QA sweep.

## work-claim-ready-queue.test.js (4 tests)
Proves the dependency ready queue: GET ?queue=ready lists unheld claims with all dependencies done; self-dependency and unknown queues refused; dependencies survive the durable registry; #1527 deleting a claim waives it from dependents. Queue-semantics suite.

## work-claim-reassign-unclaimed.test.js (4 tests)
Regression for Tab's 2026-10-06 find: reassigning an UNCLAIMED item now hands it over as a claim with the room default lease (was: owner set, state unclaimed, no lease — looked free, never expired). Reassign-shape suite.

## work-claim-renew-probe-b.test.js (1 test)
QA200-MUT-04B probe B: documents that renew starts a fresh window from now (the probed mutation was a no-op — renewWork already computes now+duration). Honest probe: proves the documented behavior, notes the mutation couldn't bite.

## work-claim-renew-probes.test.js (2 tests)
QA200-MUT-04 probes: renew without progressMessageId keeps the original lease duration (no silent 24h upgrade); renew extends from the old expiry, not from now. Renew-semantics probes.

## work-claim-retention.test.js (18 tests)
Proves retention mechanics: isFirstContribution; SLA pending/breached/answered across claim/verdict/completion events; zero-reply watchdog list + 30-day rate; done claims excluded; median latency. Retention-SLA suite.

## work-claim-schema.test.js (3 tests)
Proves startup schema boundaries: incompatible existing claim tables are refused (never silently repaired); older DBs without the tables may migrate; read-only startup permits absent tables without creating; write startup creates both tables atomically (failed commit leaves neither). Schema-safety suite.

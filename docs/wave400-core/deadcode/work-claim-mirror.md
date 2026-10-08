# work-claim-mirror.mjs — dead-code audit

Method: grepped the whole worktree (excluding node_modules) for `work-claim-mirror`, `mirrorProjectionClaim`, and `boardClaimId`.

## Exports and their callers

- `mirrorProjectionClaim` — called at `server/store.mjs:4790` (production, command-apply transaction). **Live.**
- `boardClaimId` — used internally (lines 94, 104, 125) and imported by `tests/claim-scopes.test.js:10`. Test-only external use of an exported pure helper is intentional, not dead. **Live.**

## Internal helpers — all reachable

- `BOARD_ID` / `ACTIVE` module constants — used by `boardClaimId` (13) and `claimBoard` (72).
- `filesFrom` — used by `claimBoard` (47).
- `roomLike` — used by `claimBoard` (60, 76), renew (100), handoff via claimBoard; used as the `room` arg to `claimWork`/`renewWork` (lines 59, 76, 100).
- `commit` — used on every mutation path (39, 79, 87, 100, 108, 120, 128).
- `claimBoard` — used by `mirrorProjectionClaim` (claim.acquired: 95, claim.renewed fallback: 99, handoff: 114).
- `successor` — used by handoff (120) and supersede (131).

All imports are used: `createWork`, `claimWork`, `renewWork`, `updateWork`, `roomWorkClaimConfig` (from work-claims.mjs), `emitWorkClaimEvent` (from work-claim-events.mjs).

## Verdict

**No dead code found.** Every export has a production caller (or is a deliberately exported test helper with an in-repo test consumer), and every internal function/constant is reachable on at least one event-type branch.

Closest to a candidate, but kept:
- `boardClaimId`'s export has no production importer — but it is asserted by `tests/claim-scopes.test.js` and is the module's only externally pinned id-mapping contract; removing the export would break the test. Not dead.

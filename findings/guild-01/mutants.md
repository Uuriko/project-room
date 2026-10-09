# Mutation testing — claim-core slice

15 mutants, one per work unit, each applied to a disposable worktree off
`wave1000/guild-01` with the mapped affected test file(s) run green/red.
Harness: `findings/guild-01/tools/mut-spec.json` + `mut-run.sh`; raw logs in
`findings/guild-01/mutants-raw/M{1..15}.txt`.

## Score

- **Killed: 3** (M1, M3, M14)
- **Survived: 12** — all analyzed below. None was a pre-existing bug in the
  code (no BUG CONFIRMED posted); 3 were test gaps worth closing, fixed with
  fail-first regression tests in `tests/work-claim-mutant-gaps.test.js`
  (each verified to fail against its mutant).

## Killed

| ID | Mutant | Killed by |
|---|---|---|
| M1 | lease `*3600*100` instead of `*3600*1000` (10x short) — `claimWork` | work-claim-leases.test.js |
| M3 | `isLeaseExpired`: `<` instead of `<=` at exact expiry ms | work-claim-leases.test.js |
| M14 | `assertBoardLeaseHours`: `<=` MIN rejects the documented 0.25h floor | work-claim-integrity.test.js |

## Survived — test gaps closed with regression tests

| ID | Mutant | Gap | Regression test |
|---|---|---|---|
| M4 | `updateWork` release keeps attestations (round leaks to next owner) | No test pinned the documented "attestations belong to the lapsed owner's round" invariant | `M4-gap`: release clears attestations+reviews |
| M6 | stale-outcome tie-break loses the two-`claimed`-stamps backstop | No test covered the backstop (only the round-ending-stamp clause) | `M6-gap`: tied outcome + trimmed history resets the link |
| M7 | `canCloseWork` drops the `currentReviewBasis` check (stale approve closes work) | No test made a review's basis stale | `M7-gap`: post-CI-head approve is rejected |

## Survived — equivalent / benign (no action)

| ID | Mutant | Analysis |
|---|---|---|
| M2 | `renewWork` allows renew at the exact expiry ms (`>=` vs `>`) | 1ms boundary; no observable behavior difference in any realistic clock. Equivalent. |
| M5 | `claimUpdatedAt` prefers the history stamp on ties (`>=` vs `>`) | Tie only when a stamp equals `updatedAt` to the ms; board order unchanged in practice. Equivalent. |
| M8 | `closeWhenLive`: `\|\|` instead of `&&` (never closes) | No test references `closeWhenLive` at all — weak coverage of land/deploy auto-complete, but the mutant's blast radius (land queue) is outside the mapped suites. Noted as coverage thinness, not a gap in the slice's own tests. |
| M9 | `TRANSITIONS` allows `cancel` via `updateWork` | `updateWork` still enforces the owner check, so no privilege change; the dedicated close/cancel routes remain the only path recording who/why. Behavior delta is cosmetic. |
| M10 | `nextPullBackoff`: `>=` repeats the current step | Boundary at exact step ms; poller still advances on the next tick. Equivalent. |
| M11 | `rateLimitUntil`: reset exactly at now not pushed to +60s | 1ms boundary on an already-conservative fallback. Equivalent. |
| M12 | `pullRequestOutcomeFromApi`: truthy `merged` settles | GitHub sends real booleans; no test (or caller) passes truthy non-booleans. Untestable-by-construction gap, negligible. |
| M13 | event coalescing holds for exactly 60s (`<=` vs `<`) | 1ms boundary on a memory-only rate limit. Equivalent. |
| M15 | `settlePullRequest` settles a lease lapsed exactly now (`<` vs `<=`) | 1ms boundary on the #1526 B2 guard; the guard's intent (never settle lapsed) is pinned by claim-settle-1526 tests on either side of the boundary. Equivalent. |

## Method notes

- Boundary-flip mutants (M2/M3/M5/M10/M11/M13/M15) cluster at exact-ms ties.
  M3 and M14 were killed — the suite pins *some* boundaries (lease expiry,
  board lease floor) but not the sub-ms tie semantics. Deliberate: ties are
  resolved by documented convention, not by tests.
- The three closed gaps (M4/M6/M7) share a shape: invariants stated in code
  comments with no test asserting them. The regression file pins all three.

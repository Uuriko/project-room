# re-verify R5: wave300/fix69-event-light-claims
started: 2026-10-09T09:47:42Z
HEAD is now at 2bf5ec8fb FIX-69: rework integrity tests for the digest model (notes, list view, sweep budget)
branch head: 2bf5ec8fb, merge-base with origin/main: b5c215f8
slice files changed: server/work-claim-routes.mjs 
rebase: CONFLICT — aborted, testing un-rebased head
running affected suite: tests/work-claim-events.test.js tests/work-claims-read.test.js
suite: 1 passed, 1 failed tests/work-claims-read.test.js
node --check on slice files:
done: 2026-10-09T09:49:42Z

## Adversarial review (2026-10-09)
Branch: origin/wave300/fix69-event-light-claims.
Rebase: CONFLICT — aborted, tested un-rebased head. Suite: 1 passed, 1 failed.
- The 1 failure is REAL and on the branch's own tree: tests/work-claims-read.test.js has 2 failing tests (19 tests, 17 pass, 2 fail):
  1. "a member read returns the documented page shape" — "claims carry a history tail" assertion fails (line 189).
  2. "list history tails are compacted with the remainder counted" — TypeError reading 'length' of undefined (line 201).
- Root cause: the branch intentionally changed the default list view to the summary projection (no history tails; view=full opts back in). It reworked 6 other test files for the digest model but did NOT update tests/work-claims-read.test.js, which still asserts the old default contract.
- R5-1 (branch-internal inconsistency): the branch ships a read-contract change with stale tests. On rebase the author must update work-claims-read.test.js (use view=full or assert the summary shape). Not a production bug (unmerged), but the branch as it stands is red.
Verdict: BREAKAGE (test-contract, branch-internal). Flag to the wave.

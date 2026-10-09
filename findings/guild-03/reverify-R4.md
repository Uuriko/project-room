# re-verify R4: wave300/fix5-release-compare
started: 2026-10-09T09:47:42Z
HEAD is now at 99d9f66f4 FIX-5: compare-and-release on the release route
branch head: 99d9f66f4, merge-base with origin/main: 03dd70fc
warning: origin/main...HEAD: multiple merge bases, using 03dd70fce4f3251526dc7f30f86ec1b3cd4179bd
slice files changed: server/work-claim-routes.mjs 
rebase: CONFLICT — aborted, testing un-rebased head
running affected suite: tests/work-claim-settle-retry.test.js tests/work-claim-qa-fixes.test.js tests/work-claims.test.js
suite: 2 passed, 1 failed tests/work-claim-settle-retry.test.js
node --check on slice files:
warning: origin/main...HEAD: multiple merge bases, using 03dd70fce4f3251526dc7f30f86ec1b3cd4179bd
done: 2026-10-09T09:48:18Z

## Adversarial review (2026-10-09)
Branch: origin/wave300/fix5-release-compare.
Rebase: CONFLICT — aborted, tested un-rebased head. Suite: 2 passed, 0 failed
(the earlier 1-fail row was a harness artifact: tests/work-claim-settle-retry.test.js
does not exist on this stale branch — merge-base 2026-10-07, file added on main
afterwards. Not branch breakage.)
- checkReleaseBasis: compare-and-release on release, enforced BEFORE any mutation (including the in_progress pause) — matches the E5 pattern. Good.
- Request-id idempotency (requestId + store.requestDedupe) on create/claim/update/review/close/cancel/release/reassign/renew. record() only after successful commit — failed attempts never poison the table. Good.
- R4-1 (MEDIUM, real design flaw): server/request-dedupe.mjs keys the table by bare request_id TEXT PRIMARY KEY with NO scoping — no room_id, no member, no route. Two agents (or one agent in two rooms) reusing the same requestId string (e.g. "req-1") collide: client B's mutation replays client A's stored result and B's intended write is silently skipped, with B believing it succeeded. Cross-room result leakage. Fix: scope the key by (roomId, memberId, route) or at minimum roomId. Branch is unmerged — advisory to the wave.
- R4-2 (nit): `dedupe` is declared at the top of handleWorkClaimsCore AND re-declared inside create/update branches (shadowing, same value). Harmless but sloppy.
Verdict: no test breakage on its own tree; R4-1 should block merge until fixed.

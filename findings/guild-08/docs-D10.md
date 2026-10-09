# Guild-08 suite docs — D10

## work-claim-settle-double.test.js (2 tests)
QA200 MUT-15 probe A: settlePullRequest's terminal-state guard (LIVE_CLAIM_STATES) makes double-settle impossible — a second settle of a done claim returns null, same for a released claim. Double-apply prevention suite.

## work-claim-settle-missing-link.test.js (3 tests)
Bug-hunt wave: settlePullRequest never throws on decoder-producible row shapes — null/undefined singular pull links with settled pullRequests still settle; live singular links preferred. Codec-robustness suite.

## work-claim-settle-retry.test.js (2 tests)
QA200 challenge of PR #2032: retry-after-timeout with a stale item settles exactly once (merged) and releases exactly once (closed) — commitPullRequestLookup can't double-settle what the caller handed it. Retry-idempotence suite.

## work-claim-sqlite.test.js (2 tests)
Proves the durable registry: a claim made through the real routes survives a registry rebuild on the same DB (what a DO restart/deploy does to the in-memory registry, which loses everything); room work-claim config persists across restarts. Durability contract.

## work-claim-summary-view.test.js (6 tests)
Proves ?view=summary: compact per-claim projections (id, title, state, owner, leaseExpiresAt) for the 331+ item muse-room list; default view stays byte-identical; unknown views rejected; composes with state filter and ready queue; untrusted markers preserved on member-authored titles. List-projection suite.

## work-claim-sweep.test.js (1 test)
Proves the work-claims list reports `swept` only when the lease actually lapsed (before the fix, every claim reported swept on every request — releaseExpired's fresh copies broke the route's object-identity comparison — telling agents live claims were auto-released). Single-test regression with a sharp history.

## work-claim-update-precondition.test.js (6 tests)
Proves update preconditions (QA-200 worker-13): stale note payloads replayed with v1-era basis refused; fresh basis accepted; stale history length or claimedAt conflict (409); malformed preconditions 422; precondition-less updates behave as before. Stale-write protection suite.

## work-claims-read.test.js (19 tests)
Proves GET /work-claims-read (PR #1468): the canonical stored board projection over REST — read-only page, no lifecycle housekeeping (expired leases NOT auto-released, unlike the list route); registered exactly once; dispatcher binds roomId and 405s non-GET; 401/403 auth paths; documented page shape; compacted history tails; limit honored to the 200 cap; state filters; queue=ready; bad limits 422. Read-path contract suite.

## work-claims.test.js (6 tests)
Proves the pure claim state machine (B006/B007, no store): happy path; double-claim and foreign updates refused; illegal transitions refused; release/reassign; query helpers; PR appends keep observations, invalidate approvals, need fresh explicit review; stale rounds/unsafe input refused without changing work. Core state-machine suite.

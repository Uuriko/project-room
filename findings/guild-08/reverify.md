# Guild-08 re-verify — wave branch findings

## R01: guild-claimsboard-409-enrich (b7c8ae6ac) — FULL suite
- Rebase: NO — conflicts in server/work-claim-routes.mjs.
- 729 pass, 3 fail. 2 BRANCH BUGS: the enriched 409 sets `.body` on the ServiceError, tripping the catch at work-claim-routes.mjs:557 (returns JSON instead of throwing) — breaks the throw contract (work-claim-leases, work-claim-sqlite tests fail). 1 pre-existing (room-mcp-wake, fails on base too).

## R02: guild-claimsboard-compare-release (b0003c894) — FULL suite
- Rebase: NO — conflicts in docs/openapi.yaml, server/work-claim-routes.mjs, server/work-claims.mjs.
- 729 pass, 3 fail. 1 BRANCH BUG: docs/openapi.yaml invalid YAML (YAMLParseError at line 5146). 1 perf flake (p95 89.9ms vs 50ms, likely VM load). 1 pre-existing (room-mcp-wake).

## R03: guild-claimsboard/lease-first (f9b902363) — FULL suite
- Rebase: NO — conflicts in server/work-claims.mjs.
- 711 pass, 22 fail. 21 branch-caused failures — the lease-first rework is substantially broken. 1 pre-existing.

## R04: guild-claimsboard/reaper (47c95c894) — targeted: 44 pass, 0 fail. Clean.
## R05: guild-claimsboard/standby-fifo (028e3f5fb) — targeted: 39 pass, 0 fail. Clean.
## R06: guild-claimsboard-409-shadow (c5b9aea9f) — targeted: 26 pass, 0 fail. Clean.
## R07: guild-claimsboard-boardseq (64d4bd65c) — targeted: 28 pass, 0 fail. Clean.
## R08: guild-claimsboard-mirror-cap (848963408) — targeted: 1 pass, 0 fail. Clean.
## R09: guild-claimsboard-requestid (50b27bf8d) — targeted: 10 pass, 0 fail. Clean.

## R10: guild-claimsboard/lease-first-reaper (410ab05ca) — targeted
- 87 pass, 5 fail. Failures in epoch-fencing (c2), pr-link (close/cancel event; 2× re-linking), guards (close/cancel retire). The rework breaks close/cancel event semantics and PR re-linking. Needs repair.

## Notes
- 9 of 10 branches are local-only (deleted from origin).
- All share stale base f456830e0282; R01/R02/R03/R10 cannot rebase cleanly.

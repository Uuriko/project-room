# Guild-08 mutation testing — findings

10 realistic mutants (off-by-ones, operator flips, boundary shifts).

| ID | Mutant | Result |
|---|---|---|
| M01 | settlePullRequest lapsed `<=` → `<` | SURVIVED → regression added |
| M02 | note bound `<=4000` → `<4000` | SURVIVED here, KILLED by work-claim-create-note.test.js (suite-selection artifact) |
| M03 | mayWriteWorkClaims human `\|\|` → `&&` | SURVIVED → regression added |
| M04 | collision `>1` → `>=1` | KILLED |
| M05 | claimIsActive `>` → `>=` | SURVIVED → regression added |
| M06 | validate lease `>72` → `>=72` | KILLED |
| M07 | sweep grace `<=14400` → `<14400` | KILLED |
| M08 | BOARD_LEASE_HOURS_MIN 0.25 → 0 | KILLED |
| M09 | MCP id `<=128` → `<128` | SURVIVED → regression added |
| M10 | `value<MIN` → `value<=MIN` | KILLED |

**Killed: 6. Survived with real gaps: 4.** All 4 gaps were exact-boundary
coverage holes; fail-first regressions added and verified.

## BUG CONFIRMED posts (3, to muse-room)
1. `server/claim-coordination.mjs:109` — settlePullRequest lapsed-lease `<=` boundary untested; mutant `<` survived.
2. `server/work-claim-routes.mjs:191` — mayWriteWorkClaims human `||`/`&&` untested for single-permission humans; mutant survived.
3. `src/events.js:2172` — claimIsActive expiry-instant `>`/`>=` untested; mutant survived.

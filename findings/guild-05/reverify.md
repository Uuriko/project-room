# guild-05 re-verification — findings/guild-05/reverify.md

Slice: `scripts/room`, `scripts/herdr-migrate.mjs`, `scripts/runtime-package.mjs` @ origin/main 2f6b609ef.
Date: 2026-10-09. Harness: `findings/guild-05/harness/rev.sh`.

## Wave branches touching the slice

`git ls-remote origin 'wave300/*' 'wave400/*' 'wave500/*'` → 35 branches; only 2 touch the slice:

| Unit | Branch | Result |
|------|--------|--------|
| R1 | `wave300/fix5-release-compare` | **cannot rebase cleanly** onto origin/main — conflicts in crash-recovery commits (`ec09812a7` "requestId idempotency on work-claim update path" vs newer main). Branch is stale; needs a rebase before landing. Slice diff (1 line) adversarially reviewed: registers `server/request-dedupe.mjs` in the `optional` allowlist — REQUIRED and correct, since the branch's `server/http.mjs` imports `./request-dedupe.mjs` (exact-allowlist invariant). No slice bug; branch hygiene issue only. |
| R2 | `wave300/telemetry-prod` | rebased cleanly (`a61e07c29` → `017fc931c`) onto origin/main; `runtime-package.test.js` + `asset-packaging.test.js` green (11 pass). Slice diff is additive telemetry registration; no breakage. |

## Already-filed herdr-migrate bugs (verify fixes/regressions — NOT re-filed)

| Unit | Bug | Status 2026-10-09 |
|------|-----|-------------------|
| R3a | torn journal line bricks tool (`readJournal` @ ~:464) | **STILL OPEN.** Repro: journal with a torn final line → `readJournal` throws `SyntaxError`; `appendJournalEntry` also throws (it reads first) — the tool is fully bricked until manual journal repair. No regression test in `tests/herdr-migrate.test.js`. No open fix PR found. |
| R3b | no journal lock (`appendJournalEntry` @ ~:448) | **STILL OPEN.** No `flock`/lockfile/`O_EXCL` mechanism in the source. Repro: 30 parallel appends → 30 entries, **5 duplicate `seq` values**. Journal lines themselves don't tear (single `appendFileSync` is atomic), but `seq` uniqueness is violated under concurrency. No open fix PR found. |

## Full suites on origin/main

| Unit | Suite | Result |
|------|-------|--------|
| R4 | `tests/herdr-migrate.test.js` | 35/35 pass |
| R5 | `tests/runtime-package.test.js` + `tests/asset-packaging.test.js` | 11/11 pass (~6 min) |
| R6 | room CLI guard subset (post-verb-dry-run, missing-flag-values, sweep-dry-run, clock-skew, guard, enforcer-freshness) | 30/30 pass |
| R7 | slice `git log` (30d): 415 commits touch the slice paths — volume is from repo-wide merges; slice files themselves changed in a handful (allowlist registrations, lint cleanups). No unreviewed slice change found. |
| R8 | enforcer fail-closed: worktree copy byte-identical to `origin/main:scripts/room`; `sweep --dry-run` with stubbed `gh` exits 1 (fails closed when the board can't be read) | pass |
| R9 | exit-code contract: every verb with garbage input | `sweep`/`backlog` exit 0 — **reviewed, not a bug**: both verbs take no mandatory args; empty board + `--dry-run` is a legitimate no-op plan, not a failure. All arg-bearing verbs refuse non-zero. |
| R10 | herdr-migrate dry-run default: all 12 `appendJournalEntry` call sites | all in `--execute`-gated paths (`plan` 934/941, `migrate`, `reverse`, `force-release`, `reap-orphans`); no mutating path without `--execute`. |

## Summary

- **10 re-verify units run.** Suites green on origin/main across the slice.
- 1 branch-hygiene finding: `wave300/fix5-release-compare` needs a rebase (stale, conflicts) — its 1-line slice change is correct.
- 2 already-filed bugs confirmed STILL OPEN (torn journal, journal lock) — fixes not landed, no regressions in tree. Not re-filed per guild instructions.
- 0 new bugs.

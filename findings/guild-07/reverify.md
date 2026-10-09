
# R3/R7 mini-mutations on branch slice changes (2026-10-09T10:20:21.366Z)

## R3a — KILLED
- drop markDone — entries stay pending forever; crash/recover tests should fail
- killed; tail: bf2e99c2-3eff-4a17-adb3-dafda463458e', |   +     route: '/work-claims' |   +   } |   + ] |   - [] |    |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000/reverify-fix5/tests/request-journal.test.mjs:95:10) |       at async Test.run (node:internal/test_runner/test:1404:7) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     generatedMessage: true, |     code: 'ERR_ASSERTION', |     actual: [ { id: 'bf2e99c2-3eff-4a17-adb3-dafda463458e', route: '/work-claims', body: [Object] } ], |     expected: [], |     operator: 'deepStrictEqual', |     diff: 'simple' |   } | 

## R3b — SURVIVED
- recover() returns torn temp files; corruption test should fail
- branch tests passed with mutant — GAP in branch tests

## R3c — KILLED
- entries born 'done' — recover() finds nothing; crash test should fail
- killed; tail: wave1000/reverify-fix5/tests/request-journal.test.mjs:118:10) |       at Test.runInAsyncScope (node:async_hooks:227:14) |       at Test.run (node:internal/test_runner/test:1397:25) |       at Test.processPendingSubtests (node:internal/test_runner/test:969:18) |       at Test.postRun (node:internal/test_runner/test:1537:19) |       at Test.run (node:internal/test_runner/test:1462:12) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     generatedMessage: false, |     code: 'ERR_ASSERTION', |     actual: 0, |     expected: 1, |     operator: 'strictEqual', |     diff: 'simple' |   } | 

## R7a — SURVIVED
- off-by-one allows maxAttempts+1 mutation attempts; bound test should fail
- branch tests passed with mutant — GAP in branch tests

## R7b — KILLED
- inverted reconcile decision — conflicts returned as applied; conflict tests should fail
- killed; tail: ASSERTION]: one ambiguous attempt plus one same-requestId retry |    |   1 !== 2 |    |       at TestContext.<anonymous> (file:///home/hatch/workspace/pr-wave1000/reverify-fix6/tests/public-work-claims-retry-discipline.test.js:131:10) |       at process.processTicksAndRejections (node:internal/process/task_queues:104:5) |       at async Test.run (node:internal/test_runner/test:1404:7) |       at async Test.processPendingSubtests (node:internal/test_runner/test:969:7) { |     generatedMessage: false, |     code: 'ERR_ASSERTION', |     actual: 1, |     expected: 2, |     operator: 'strictEqual', |     diff: 'simple' |   } | 

## R7c — SURVIVED
- drop the 200-invalid_response ambiguous arm; reconcile test should fail
- branch tests passed with mutant — GAP in branch tests


# Re-verify rollup — wave branches touching the client-web slice

Scope: `git ls-remote origin 'wave300/*' 'wave400/*' 'wave500/*'` → diffed each against `origin/main` for `client/*`, root HTML, `icons/`, `manifest.webmanifest`, `favicon*`. **Only 2 of ~40 branches touch the slice** (R9 negative sweep below). Both re-verified.

## wave300/fix5-release-compare — client/request-journal.mjs (NEW)

- **R1 rebase+tests:** `git rebase origin/main` on a scratch worktree **conflicts** in `server/work-claim-routes.mjs` + `server/work-claims.mjs` (outside this slice; branch needs a rebase before merge — note: the first rebase attempt's conflict was masked by a pipe-exit-code bug in the helper script; the conflict was found on manual inspection and the rebase aborted cleanly). Slice verification done on the branch tip instead: the new module imports only node stdlib, and `tests/request-journal.test.mjs` passes **7/7** there. `tests/reply-agent.test.js` shows 1 failure on the rebased tree — **verified pre-existing on clean origin/main** (same test, "one command drives a separate host process…", fails on main too; environment/timing-sensitive, not caused by this branch).
- **R2 adversarial review** of `client/request-journal.mjs` (165 lines): persist-before-send holds (`begin()` writes the entry before returning the sender); `send()` marks done only after the transport resolves; transport rejection keeps the entry pending; `recover()` skips `.done.json`, `.tmp-` leftovers, and corrupt JSON. **Observation (not a bug):** `.done.json` files are never pruned client-side — a long-lived agent accumulates one per request, unbounded disk growth (the server side has prune; the client does not).
- **R3 mini-mutations** (above): R3a KILLED, R3b SURVIVED (torn-temp skip untested), R3c KILLED.
- **R4 lineage:** merge-base `03dd70fce` with origin/main (27h old at check), proper main lineage — not a lane-tip fork. The rebase conflicts are genuine main-moved-on drift in server files.

## wave300/fix6-client-retry-discipline — client/public-work-claims.mjs (+72)

- **R5 rebase+tests:** branch already **merged to main via PR #2139** (`git diff <branch-tip> origin/main -- <slice files>` = 0 lines); rebase was a no-op. `tests/public-work-claims-retry-discipline.test.js` + `tests/public-work-claims-client.test.js`: **9/9 pass** on current main.
- **R6 adversarial review** of `withClaimRetryDiscipline`/`reconcileRetry`: every 4xx terminal after exactly one attempt; ambiguous outcomes (timeout/5xx/200-unparseable) trigger a confirming `read()` before any decision; already-applied → return the read; conflict → terminal 409; retry keeps the SAME requestId; attempts bounded by `maxAttempts` (1–10, exactly N mutation attempts — traced); release is never re-sent once the claim is gone (can't strike another holder's claim); `identityId` required for reconciliation. `invalid_config`-class local errors are not treated as ambiguous. No unbounded loop. **No issues found.**
- **R7 mini-mutations** (above): R7a SURVIVED (exact attempt bound untested), R7b KILLED, R7c SURVIVED (200-`invalid_response` arm untested).
- **R8 lineage:** merge-base `b5c215f8` (13h old), merged via PR #2139 — clean.

## R9 negative sweep (evidence)

Full `git diff --name-only origin/main...origin/<branch>` for every wave300/wave400/wave500 branch, grepped for `^(client/|index\.html|join\.html|about\.html|offers\.html|404\.html|offline\.html|operator\.html|icons/|manifest\.webmanifest|favicon|icon\.svg)` and for test files covering client modules. Only the two branches above matched. All other wave branches are clear of this slice.

## R10 branch tests against current main

- fix6: merged — its tests run green on current origin/main (9/9).
- fix5: not merged — `tests/request-journal.test.mjs` 7/7 on the branch tip; the module has zero repo imports (node stdlib only), so main-compatibility is by construction. The branch's server-side changes need a rebase (conflicts noted above) before its server tests can run on main.

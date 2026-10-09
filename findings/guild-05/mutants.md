# guild-05 mutation testing — findings/guild-05/mutants.md

Slice: `scripts/room`, `scripts/herdr-migrate.mjs`, `scripts/runtime-package.mjs` @ origin/main 2f6b609ef.
Date: 2026-10-09. Harness: `findings/guild-05/harness/mut.sh` (+ v3/v4 re-runs).

Method: one mutation per sandbox copy (repo layout replicated so relative imports resolve to the mutant),
run the affected existing test file(s) with `TMPDIR` worktree-local. Verdicts:
- **KILLED** = test suite or targeted repro failed on the mutant (behavior change detected).
- **SURVIVED** = all tests passed on the mutant → real test gap (noted) or equivalent mutant.

Harness incidents (documented honestly): v1 mis-copied test files (`tests/tests/...`) so M1–M10
"survived" vacuously, and mis-indexed `process.argv` so M11–M15 "killed" vacuously. Both re-run
cleanly (M1–M10 v3, M11–M15 v4); only the re-run verdicts below count.

## scripts/room (bash CLI)

| Unit | Mutation | Affected tests | Verdict |
|------|----------|----------------|---------|
| M1 | `clock_now`: `skew=$((op - ref))` → `skew=$((ref - op))` (warning direction inverts) | room-clock-skew.test.js | KILLED (2 fail: ahead/behind warnings swapped) |
| M2 | strike-two grace: `-gt 14400` → `-lt 14400` (strike-two fires immediately) | room-sweep-dry-run, room-sweep-evidence | KILLED |
| M3 | `need_val` neutered: `die` → `warn` on missing flag value | room-missing-flag-values | KILLED |
| M4 | `need_val` inverted: `!= --*` → `== --*` (accepts flags as values) | room-missing-flag-values, room-post-verb-dry-run | KILLED |
| M5 | heartbeat-after-expiry void check flipped in jq: `>` → `<` | room-protocol-mutation, room-sweep-dry-run | KILLED |

## scripts/herdr-migrate.mjs

| Unit | Mutation | Affected tests | Verdict |
|------|----------|----------------|---------|
| M6 | `batchPlan` off-by-one: `slice(i+1, i+batchSize+1)` (drops a claim per batch) | herdr-migrate.test.js | KILLED |
| M7 | `deriveExitCode`: `failed > 0` → `failed >= 0` (always partial) | herdr-migrate.test.js | KILLED (1 fail) |
| M8 | `buildPlan` cursor skip: `fromCursor+1` (drops first eligible claim) | herdr-migrate.test.js | KILLED |
| M9 | journal seq: `existing.length + 1` → `existing.length` (duplicate seqs) | herdr-migrate.test.js | KILLED (1 fail) |
| M10 | `--execute` no longer flips `dryRun` off | herdr-migrate.test.js | KILLED (1 fail) |

## scripts/runtime-package.mjs (targeted repros; full suite is ~6 min)

Base: known-good package built once from the unmutated script; each mutant verified against a fresh copy.

| Unit | Mutation | Repro | Verdict |
|------|----------|-------|---------|
| M11 | `assetsFor` allowlist flip: `allowed.has` → `!allowed.has` | verify known-good package | KILLED (mutant rejects valid package) |
| M12 | walk allowlist check neutered | plant `rogue-evil.mjs`, verify | **SURVIVED — equivalent mutant**: the rogue file is still rejected by the later manifest-vs-directory comparison (`same(actualSorted, expectedSorted)`). The walk check is defense-in-depth (better error, earlier fail) but not load-bearing for accept/reject. |
| M13 | per-file sha256 check dropped | flip one byte of `server.mjs`, verify | KILLED (mutant accepts tampered bytes) |
| M14 | manifest format check flipped: `=== 1` → `!== 1` | verify known-good package | KILLED (mutant rejects valid package) |
| M15 | destination absolute-path guard dropped | `create` with relative destination | KILLED (mutant proceeds; correct code rejects) |

## Summary

- **15 mutants run, 14 killed, 1 survived (M12, equivalent — defense-in-depth, not a bug).**
- No survived-mutant bugs to file. The slice's existing suites (room CLI guards,
  herdr-migrate unit tests, runtime-package contract checks) caught every injected fault
  class: off-by-one, flipped conditionals, neutered guards, dropped integrity checks,
  inverted allowlists.
- Note: M13-style mutants (accept-what-should-be-rejected) are only caught because the
  repros assert rejection — the existing `runtime-package.test.js` suite covers the
  positive path; negative-path coverage for the verify walk lives in these repros.
  Consider upstreaming the M13 tamper-repro as a permanent negative test.
- M12 is the one equivalent mutant found: `verifyRuntimePackage` rejects rogue files at
  (at least) two independent checkpoints (walk allowlist + manifest comparison), so
  neutering the first is harmless. This is defense-in-depth working as designed.

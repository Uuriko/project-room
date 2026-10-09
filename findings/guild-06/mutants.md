# Mutation testing — guild-06 (scripts-rest)

Head: `a436d0cac` · 2026-10-08/09. Method: per script, 2 targeted mutants
(off-by-one, flipped conditional, dropped throw, wrong operator, some→every),
each applied to a disposable `origin/main` worktree; the script's own test file
run per mutant (`node --test`, ≤600s, worktree-local TMPDIR). Baseline: all 15
test files green unmutated.

## Scoreboard

- Mutants run: **30** (15 units × 2)
- Killed: **20**
- Survived: **10** (2 equivalent, 8 test gaps)
- Not applied / infra errors: 0
- Real bugs found: **0** → no BUG CONFIRMED posts, no new regression tests owed
  (per program: fail-first tests only for survived mutants that are real bugs).

## Killed (20)

| unit | mutant | test |
|---|---|---|
| mut-01 | db-origin-conflict-weakened (`&&`→`‖`) | access-review.test.js |
| mut-01 | revoke-arity-2 (`!==1`→`!==2`) | access-review.test.js |
| mut-02 | usage-check-dropped (throw removed) | agent-doctor.test.js |
| mut-02 | credential-some-to-every | agent-doctor.test.js |
| mut-03 | focus-validation-inverted | agent-resume.test.js |
| mut-04 | zero-checkpoint-rejected (`<0`→`<=0`) | agent-work-preflight.test.js |
| mut-04 | cursor-guard-weakened (`‖`→`&&`) | agent-work-preflight.test.js |
| mut-06 | sort-order-reversed | answer-engine-check.test.js |
| mut-07 | zero-interval-allowed (`<1`→`<0`) | backup-verify.test.js |
| mut-07 | cron-arity-6 (`===5`→`===6`) | backup-verify.test.js |
| mut-08 | watermark-version-2 | rel14-backup-bytes.test.js |
| mut-08 | attachment-check-inverted | rel14-backup-bytes.test.js |
| mut-09 | report-always-ok (`===0`→`>=0`) | bounty-conservation-check.test.js |
| mut-09 | escrow-branch-inverted | bounty-conservation-check.test.js |
| mut-10 | format-both-dropped | regex-parity.test.js |
| mut-11 | severity-validation-inverted | dependency-audit.test.js |
| mut-12 | empty-suite-inverted | flaky-detect.test.js |
| mut-13 | map-version-2 | journey-coverage.test.js |
| mut-13 | dup-detection-inverted | journey-coverage.test.js |
| mut-14 | verdict-status-swapped (405→404) | openapi-method-accuracy.test.js |

## Survived — equivalent (2)

Both in `scripts/analytics-backfill.mjs` `copyTable()`: its boolean return value
is **discarded at the only call site** (`for (const name of TABLES)
copyTable(source, scratch, name);` — `backfillFile`, line 37). No test can ever
distinguish these mutants; they are equivalent by construction.

- `empty-table-inverted`: `if (!rows.length || !cols.length) return true` → `return false`.
- `sql-presence-inverted`: `if (!row?.sql) return false` → `return true`.

Observation (not a bug): `copyTable`'s return contract is unobserved — the
true/false returns are dead weight. A future cleanup could make it return void.
Left untouched (no behavior change warranted).

## Survived — test gaps (8)

The mutant is a genuine behavior change; the original code is correct; the
script's test file simply never exercises the path. Each is a concrete,
reproducible gap (apply the mutant, run the test file, watch it pass).

1. `claims-index.mjs` — `arg-off-by-one`: `opt()` trailing valueless flag returns
   `undefined` instead of the default (`i + 1 < args.length` → `<=`). Survives
   because `regex-parity.test.js` tests regex parity, not CLI parsing — **no test
   covers `claims-index.mjs` arg parsing at all**. Repro: `node
   scripts/claims-index.mjs --comments f --format` (trailing `--format`) →
   mutant writes to path `undefined` instead of erroring on bad format.
2. `agent-resume.mjs` — `dup-arg-allowed`: duplicate flags no longer rejected
   (`Object.hasOwn` check dropped). No duplicate-flag test; second value would
   silently win.
3. `answer-engine-check.mjs` — `prompt-validation-every`: `.some`→`.every` on
   the bad-prompt check. Fixtures are all-valid, so both agree; no mixed
   valid/invalid prompt fixture exists.
4. `dependency-audit.mjs` — `error-detection-every`: `.some(Boolean)`→`.every(Boolean)`
   over `[code, summary, detail]`. Fixtures carry all-or-no error fields; a
   partial error object (e.g. only `code`) would slip past the mutant undetected.
5. `flaky-detect.mjs` — `stack-pop-boundary`: `>=`→`>` in the indent stack pop.
   Fixtures never nest two sub-comments at equal indent; the tree-building
   boundary for equal indents is untested.
6. `openapi-method-accuracy.mjs` — `status-check-and`: `‖`→`&&` makes the
   404/405 JSON-error-body branch dead. Fixtures never return 404/405 with a
   JSON body, so the error-detail path is untested.
7. `analytics-backfill.mjs` — `unfinished-backfill-ok`: `if (!tail.done) throw`
   removed. The honesty test's tail always finishes; the unfinished-tail path is
   untested.
8. `analytics-backfill.mjs` — `loop-guard-shrunk`: `guard < 10000` → `guard < 2`.
   Test fixtures finish in ≤2 tail iterations, so the safety bound is never
   approached in tests (equivalent on tested inputs; untestable without a large
   fixture).

## Raw logs

`findings/guild-06/logs/mut-{01..15}.result` (verdicts), `mut-{01..15}.log` +
per-mutant `.stdout` (full `node --test` output). Baseline sweep:
`findings/guild-06/logs/baseline.result` (all 15 files exit 0 unmutated).

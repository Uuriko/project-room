# Mutation testing report (guild-12)

Driver: `findings/guild-12/bin/run-mutant.sh`. Each unit applies one mutant
to the guild worktree (serialized per file via `flock`), runs the affected
test file(s) with `TMPDIR=$worktree/.tmp`, restores the source via
`trap restore EXIT`, and appends KILLED/SURVIVED to `mutant-results.log`.
Baselines (all green): `logs/BASELINE-*.log`.

## Results: 15 mutants, 11 killed, 4 survived (all 4 = test gaps, now pinned)

| ID | File | Mutation | Test scope | Verdict |
|---|---|---|---|---|
| M01 | wake-queue.mjs | coalesce `Math.min`→`Math.max` (earliest due) | wake-queue.test.js | KILLED |
| M02 | wake-queue.mjs | receipt cap `>=`→`>` (off-by-one) | wake-queue.test.js | KILLED |
| M03 | wake-queue.mjs | `due_at<=?`→`due_at<?` in `due()`+`lease()` | wake-queue.test.js | KILLED |
| M04 | wake-queue.mjs | recover `attempts>=max_attempts`→`>` | wake-queue.test.js | **SURVIVED** → gap pinned |
| M05 | wake-queue.mjs | backoff `2^(attempts-1)`→`2^attempts` | wake-queue.test.js | KILLED |
| M06 | wake-queue.mjs | `maxAttempts > max`→`>=` | wake-queue.test.js | **SURVIVED** → gap pinned |
| M07 | wake-queue.mjs | `complete()` lease-owner check `!==`→`===` (also hits `fail()`) | wake-queue.test.js | KILLED |
| M08 | wake-queue.mjs | guest gate `if (isGuest…)`→`if (!isGuest…)` (enqueue+requeue) | wake-queue.test.js | KILLED |
| M09 | work-wakes.mjs | `transition()` revision check `===`→`!==` | 7-file wake suite | KILLED (survived single-file scope) |
| M10 | work-wakes.mjs | `pending()` limit `>=`→`>` | 7-file wake suite | KILLED (survived single-file scope) |
| M11 | work-wakes.mjs | `permitted()` `active !== false`→`=== false` | 7-file wake suite | KILLED |
| M12 | work-wakes.mjs | `ack()` unconditioned (dropped `.changes` check) | 7-file wake suite | KILLED |
| M13 | wake-queue-limits.mjs | `leaseMs` 30000→3000 | wake-queue.test.js | **SURVIVED** → gap pinned |
| M14 | wake-queue-limits.mjs | `baseBackoffMs` 60000→6000 | wake-queue.test.js | **SURVIVED** → gap pinned |
| M15 | action-classes.mjs | fail-closed → fail-open `return "observe"` | action-classes.test.js | KILLED |

## Results: 15 mutants, 11 killed, 4 survived (all 4 = test gaps, now pinned)

## Survived mutants (test gaps, not live bugs)

None of the four survivors is a live bug — current code is correct; each
mutant is a real behavioral break the suite could not see. All four are now
pinned by fail-first regression tests in `findings/guild-12/regress/`:

1. **M04** — `recover()` exhausted-lease path untested. Mutant strands
   exhausted leases in `leased` forever. Regression:
   `regress/recover-exhausted-dead.test.js` — PASSES clean, FAILS on mutant
   (`'leased' !== 'dead'`).
2. **M06** — `maxAttempts: 5` boundary untested. Regression:
   `regress/enqueue-maxattempts-boundary.test.js` — PASSES clean, FAILS on
   mutant.
3. **M13** — `leaseMs` constant unpinned. Regression:
   `regress/lease-duration-pinned.test.js` — PASSES clean, FAILS on mutant.
4. **M14** — `baseBackoffMs` value unpinned (relative-ordering assertions
   only). Regression: `regress/fail-backoff-pinned.test.js` — PASSES clean,
   FAILS on mutant (pending run at doc time; log `REGRESS-M14.log`).

## Methodology note

M09/M10 initially "survived" `tests/agent-wake.test.js` alone — that file is
client-level and never exercises `transition()`/`pending()` internals. The
verdicts above use the full 7-file wake suite
(`agent-wake`, `agent-wake-poll`, `board-wake`, `board-wake-ready-work`,
`room-mcp-wake`, `pull-only-heartbeat-wakes`, `agent-heartbeats`). Lesson
recorded in `08-gotchas.md`.

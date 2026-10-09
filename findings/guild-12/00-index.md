# Guild-12 (streams) — findings index

Verification of the streams slice (`server/*stream*.mjs`, `server/*sse*.mjs`,
`server/*wake*.mjs`) for WAVE-1000. Branch: `wave1000/guild-12`.

## Mutation testing

- [`10-mutants.md`](10-mutants.md) — 15 mutants run, 11 killed, 4 survived
  (all survivors = test gaps, none live bugs; each pinned with a fail-first
  regression test in `regress/`).

## Fuzz + load

- [`11-fuzz-load-report.md`](11-fuzz-load-report.md) — 15 fuzz inputs (F1–F15),
  all passing. Load: 300/500 concurrent stream attempts, event-loop lag and CPU
  measured. 3 findings (2 low-severity bugs with repros, 1 medium load
  observation).

## Re-verification (wave300 fanout-perf branch)

- [`12-reverify-report.md`](12-reverify-report.md) — scratch rebase onto
  origin/main, full suite results, 34x claim verified (~52x measured),
  1 breakage found (`work-claim-board-seq.test.js`, branch-owner's fix).

## Module documentation

- [`01-modules.md`](01-modules.md) — what each module owns.
- [`02-stream-lifecycle.md`](02-stream-lifecycle.md) — open → pump → close.
- [`03-resume-semantics.md`](03-resume-semantics.md) — `after`, Last-Event-ID,
  409 on future cursors.
- [`04-drop-policies.md`](04-drop-policies.md) — 100-stream cap, 3-per-credential,
  lagging-drop, 429s.
- [`05-wake-delivery.md`](05-wake-delivery.md) — wake queue delivery guarantees.
- [`06-work-wakes-delivery.md`](06-work-wakes-delivery.md) — work-wake delivery.
- [`07-action-classes.md`](07-action-classes.md) — action classes.
- [`08-gotchas.md`](08-gotchas.md) — gotchas (incl. the M09–M12 lesson).
- [`09-dead-code.md`](09-dead-code.md) — reachability audit (no dead code found).

## Harnesses

- `bin/sse-fuzz.mjs`, `bin/wake-fuzz.mjs` — fuzz harnesses.
- `bin/run-fuzz.sh` — launcher (hard timeouts, verdicts in `fuzz-results.log`).
- `bin/run-mutant.sh` — mutation driver (flock per file, trap restore).
- `regress/` — 5 fail-first regression tests.

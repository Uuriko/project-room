# Chaos harness

A deterministic, seeded chaos harness for Project Room's reliability work.
Scenarios are async functions that run against a scratch SQLite DB with
seeded fault injection; invariant checkers record every evaluation; the
runner writes one JSONL line per scenario.

Scaffold: `tests/chaos/chaos-kit.mjs` (core), `tests/chaos/chaos-runner.mjs`
(runner + CLI), `tests/chaos/scenarios/*.mjs` (scenarios),
`tests/chaos/chaos-runner.test.js` (self-checks).

## Why deterministic

The QA-200 race findings were seed-dependent: a race reproduces only under
the exact interleaving that triggers it. The harness makes the interleaving
itself a pure function of the seed, so a failure found at seed N replays
byte-identically at seed N — on any machine, in any order, any number of
times. The contract:

- The **only** randomness source is the seeded PRNG (`mulberry32`).
  No `Math.random()`, no `Date.now()` in any decision path.
- Each scenario gets its own stream (`streamRng(seed, scenarioName)`), so
  scenario execution order cannot affect a scenario's draws.
- Same seed + same scenario + same code ⇒ identical `{scenario, seed,
  faults, outcome, checks}`. Wall-clock fields (`at`, `elapsed_ms`) are
  excluded from comparison.

`tests/chaos/chaos-runner.test.js` enforces this: it runs the whole harness
twice in-process with the same seed and requires identical report
projections.

## Running it

```sh
# All scenarios, one seed; report to tests/chaos/reports/chaos-seed-42.jsonl
node tests/chaos/chaos-runner.mjs --seed 42

# One scenario, custom report path
node tests/chaos/chaos-runner.mjs --seed 42 --scenario claim-release --report /tmp/chaos.jsonl

# List registered scenarios
node tests/chaos/chaos-runner.mjs --list

# In the repo's safe test env (TMPDIR -> worktree-local .tmp/)
scripts/test-env.sh node --test tests/chaos/chaos-runner.test.js
```

Scratch DBs live under `$TMPDIR` (never `/tmp` directly — it is a small
shared tmpfs that gets reaped) and are removed after a passing run; on
failure the DB directory is kept for post-mortem.

## Writing a scenario

A scenario is a module in `tests/chaos/scenarios/` exporting:

```js
export const name = "my-scenario";          // unique, kebab-case
export const description = "one line";       // shown by --list
export async function run(ctx) { /* ... */ }
```

`ctx` is a `ChaosContext`:

**Randomness** (seeded; the only allowed source)

- `ctx.rand()` — float in [0, 1)
- `ctx.int(min, max)` — integer in [min, max]
- `ctx.pick(array)` — one element

**Database**

- `ctx.db` — the scratch `node:sqlite` `DatabaseSync` (WAL, `synchronous=NORMAL`)
- `ctx.dbPath`, `ctx.dbDir` — where it lives

**Fault injection** (every injection is recorded in the report's `faults`)

- `await ctx.delay(maxMs)` — sleep a seeded 0..maxMs. Wall time only;
  never affects the logical outcome.
- `await ctx.yieldPoint(label)` — seeded scheduling point: a real
  zero-delay yield so interleaved tasks actually interleave, at a fixed
  position for the seed.
- `ctx.faultyFsync()` — drops durability (`journal_mode=DELETE`,
  `synchronous=OFF`): the scenario must keep its invariants anyway.
- `ctx.shuffleInPlace(array)` — seeded Fisher–Yates; the full permutation
  is recorded so the exact order replays.
- `ctx.armKill(maxStatements)` / `ctx.armKillAt(index)` — arm a process
  crash at a (seeded or explicit) statement index. Call `ctx.statement()`
  once per statement inside a transaction; at the armed index the DB
  connection is dropped abruptly and `ChaosKillError` is thrown.
  Catch it, `ctx.reopenDb()` (the journal rolls the dead transaction
  back), assert the invariants, and continue.

**Invariants**

- `ctx.assertInvariant(name, ok, detail)` — records `{name, ok, detail}`
  in the report's `checks` and throws `ChaosInvariantError` on failure.
  A scenario passes iff it returns without throwing and every check is ok.

Prefer small, named invariants over one big assertion: the report shows
exactly which one broke, with the detail string.

## Report format

One JSON object per line:

```json
{"scenario":"claim-release","seed":42,
 "faults":[{"type":"delay","ms":2},{"type":"order_reversal","permutation":[2,0,1]}],
 "outcome":"pass",
 "checks":[{"name":"single-winner-per-claim","ok":true,"detail":null}],
 "at":"2026-10-08T...Z","elapsed_ms":1310}
```

On failure, `outcome` is `"fail"` and an `error: {name, message}` field is
added. `at` / `elapsed_ms` are wall-clock only — strip them before
comparing two runs.

## Demo scenarios

- **claim-release** — two agents race claims on work items under seeded
  delays and an order-reversed batch. Invariants: exactly one winner per
  item, the winner owns it in the DB, only the owner can release,
  stranger releases are no-ops, final state is fully released with an
  intact version chain. (Fail-first history: the first draft used
  read-then-write claiming; the harness flagged a lost-update violation
  at seed 42 — `winners=2` on `single-winner-per-claim` — the scenario now
  claims atomically and passes deterministically.)
- **transfer-conservation** — 50 seeded transfers between two accounts
  under order reversal, a mid-run faulty fsync, and a seeded
  kill-mid-transaction (with client retry). Invariants: total funds
  conserved at every checkpoint and at the end, the killed transfer left
  no partial row, the log is complete, no negative balances.

## Rules for new scenarios

1. All nondeterminism goes through `ctx` — never `Math.random()`,
   `Date.now()`, or real network/clocks in decision paths.
2. Scenarios must pass on current `main` before they are merged (the
   harness is a regression net, not a bug tracker). Write the scenario to
   fail first against the buggy behavior, then keep the passing form.
3. Keep fault schedules small enough that a report stays readable; the
   permutation and kill index are recorded so reviewers can replay them.
4. Do not assert on wall-clock timing — `delay()` affects duration only.

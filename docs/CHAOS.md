# Chaos / property harness

Deterministic, seeded property tests for the room's state machines. They run
random operation sequences against the real code and assert invariants after
**every** op — applied or rejected. A failing seed replays exactly, so a CI
failure is debuggable locally with one command.

This is **permanent prevention**: the properties live in `tests/chaos/` and
run on every CI pass. One-off bug-finding fuzzing (throwaway runs, no
committed properties) is WAVE-400's lane — different job, no overlap.

## What's covered

| File | Properties |
|---|---|
| `tests/chaos/invite-lifecycle.test.js` | **P1** random mint/redeem/revoke/expire sequences: every redeemed code links exactly one member (exactly-once), every agent member traces to exactly one redeemed code (no orphans), no code ever both redeemed and revoked. **P2** redeem racing revoke: all interleavings resolve to exactly one outcome — never both, never two successful redeems. |
| `tests/chaos/escrow-transitions.test.js` | **P3** money conserved (`verifyConservation()` clean, `totalIssued` constant — genesis is the one and only mint). **P4** no double-release (≤1 payout movement per bounty, payout ≤ award). **P5** terminal states terminal (`paid`/`refunded`/`cancelled` never change again). |
| `tests/chaos/harness.selftest.test.js` | The runner's own contract: deterministic seeds, expected rejections counted, unexpected errors fail, broken models reported with reproduction. |
| `tests/chaos/harness.mjs`, `tests/chaos/seeded-random.mjs` | The runner and PRNG (not tests; not discovered by `node --test`). |

## How to run

```sh
# Smoke: the default. Fast enough for CI and local iteration.
node --test tests/chaos/

# One property file:
node --test tests/chaos/escrow-transitions.test.js

# Full: more seeds x more ops. For pre-merge confidence and nightly runs.
CHAOS_MODE=full node --test tests/chaos/
```

Knobs (env):

| Variable | Effect |
|---|---|
| `CHAOS_MODE=smoke\|full` | Preset budgets (default `smoke`). |
| `CHAOS_SEEDS=N` | Override seed count for this run. |
| `CHAOS_OPS=N` | Override ops per seed for this run. |
| `CHAOS_SEED=N` | Run **only** seed N (reproduction; see below). |
| `CHAOS_SEED_BASE=N` | Shift the seed sequence (default per-property). |

Smoke budgets are tuned so each file lands in the 10–60s range (see
`scripts/unit-ci-durations.json`). Full mode is ~5–10x.

## How to add a property

A property is one `runProperty()` call. You supply four functions; the
runner handles seeds, op counting, shrinking, and reporting:

```js
import { runProperty } from "./harness.mjs";

await runProperty({
  name: "my-machine",                        // printed in reports
  file: "tests/chaos/my-machine.test.js",    // printed in the repro command
  defaultSeeds: { smoke: 10, full: 100 },    // budget presets
  defaultOps: { smoke: 40, full: 150 },
  defaultSeedBase: 0xmy5eed,                 // first seed; distinct per property

  // Fresh, independent fixture per seed. rng is yours alone: every random
  // choice the driver makes must come from it (never Math.random), or the
  // seed won't replay.
  build: (seed, rng) => ({ /* db handles, mock clock, op pools */ }),

  // One random op. Return a short log label ("fund CHAOSROOM-3").
  // May throw an error with a string `.code` (ServiceError/EscrowError):
  // that is an EXPECTED domain rejection (illegal transition in a random
  // sequence) — counted, logged as `(rejected <code>)`, run continues.
  // Any other throw is a real bug and fails the property.
  perform: (ctx, rng, opIndex) => { /* ... */ return "did the thing"; },

  // Invariants, read from the source of truth (the DB), after every op —
  // including rejected ones. Throw (assert.*) on violation.
  checkInvariants: (ctx, opIndex, label) => { /* ... */ },

  // Optional: runs once per seed attempt, even on failure (close DBs, rm dirs).
  teardown: ctx => { /* ... */ },
});
```

Rules of the road:

- **Invariants read state, never the driver's memory.** The driver may track
  hints (candidate pools, last-seen states) but every assertion re-reads the
  database. A property that checks its own bookkeeping proves nothing.
- **Failures are first-class inputs.** Random sequences hit illegal states
  constantly; the property must hold for rejected ops too. That's where
  torn-write bugs hide.
- **Bias toward depth.** Pure-uniform op choice rarely reaches deep states
  (accepted → disputed → decided → paid). Prefer candidates in the right
  pre-state, fall back to any target. Print a coverage line (states seen,
  deep-path counters) so a vacuous walk is visible.
- **Keep smoke fast.** If a fixture is expensive (RoomStore init does real
  schema work), use fewer seeds × fewer ops in smoke and put the depth in
  full. Measure the file's solo wall-clock and record it in
  `scripts/unit-ci-durations.json` (`milliseconds`).

## How to add a seed

Seeds are just integers: seed `s` of a property is `seedBase + s`. To add
coverage, raise `defaultSeeds` / `defaultOps` (full preset first). To pin a
regression found in the wild:

1. Reproduce it as a minimal op log (see below).
2. Either extend the random driver so the seed space reaches it, or — if the
   shape is too specific for random search — add a small deterministic test
   next to the property (like P2's interleaving matrix next to P1's random
   walk) that performs exactly those ops and asserts the invariant.

`CHAOS_SEED_BASE` shifts the whole sequence without touching the code — handy
for a quick extra sweep: `CHAOS_SEED_BASE=99999 node --test tests/chaos/`.

## How to read a failure

```
CHAOS FAILURE — property "escrow-transitions"
  seed:        15057416
  phase:       check (op index 34)
  error:       AssertionError: conservation violated: ["global sum 404000 != genesis 400000"]
  op log:
    [0] post CHAOSROOM-1 5cr by id:agent/grokbot
    ...
    [34] epoch: approved=0 swept=1 refunded=0 released=0 failed=0
  reproduce:   CHAOS_SEED=15057416 CHAOS_OPS=35 node --test tests/chaos/escrow-transitions.test.js
```

- **phase `perform`**: the op itself threw something unexpected (no string
  `.code`) — a crash, not a domain rejection. The bug is in the op path.
- **phase `check`**: an invariant broke after the op. The bug is whatever the
  op (or an earlier op in the log) did to the state.
- **shrunk to**: the runner bisected the op log to the minimal failing
  prefix; the printed log is already minimal.
- **reproduce**: run exactly that. `CHAOS_SEED` + `CHAOS_OPS` replays the
  same deterministic op sequence against a fresh fixture. Add your own
  logging, fix, re-run until green, then run the full file.

The `chaos ok:` line on success tells you what ran:
`25 seed(s) x 60 ops, 848 applied, 652 expected rejections, 0 failures [mode=smoke]`.

## Related

- `tests/chaos/work-claim-chaos-scaffold.mjs` (PRODUCT-200 C3): fault-injection
  at the storage layer for the **work-claim** state machine (kill the isolate
  mid-write, assert no torn rows). Different layer, different machine — the
  two harnesses coexist: that one injects storage faults, this one drives
  random op sequences against invite and escrow logic.
- WAVE-400's fuzzing front: one-off bug-finding runs, nothing committed.

## Fail-first

These properties guard already-correct code, so "red" was demonstrated by
mutation, not by a real bug: with a scratch `--import` shim that made every
9th journal movement mint a phantom credit, `escrow-transitions` failed with
`global sum 404000 != genesis 400000` and a seed repro; with a shim that
un-burned invite codes after redeem, `invite-lifecycle` failed with
`agent member … has no redeemed invite code (orphan)`, shrunk to 5 ops. The
shims lived in `/tmp` and were deleted after — nothing in the repo was
weakened to make the tests pass.

When you add a property, do the same: break the invariant on purpose in
`/tmp`, watch the property catch it with a usable repro, then delete the
shim. A property that has never been seen to fail is a rumor.

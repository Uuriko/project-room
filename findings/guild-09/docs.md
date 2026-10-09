# Guild-09 docs — track 4 rollup (10 units)

10 units × ~88 suites = **881 suites documented** in docs/batch-1.md … batch-10.md.
Per suite: line count, test() count, strict-assertion count, what it proves
(HTTP surface / sqlite-backed behavior / pure unit logic / coverage surface),
and flags.

## Headline findings

- **Suites with no real assertions: 0.** The 2 initial flags
  (webhook-dispatch-store.test.js, telegram-webhook-rotation.test.js) were
  verified as compressed-payload loader shims — their generated modules carry
  real assertions (163 asserts / 24 tests; 11 tests), all green on re-run.
  Batch docs corrected.
- **Thin suites** (<1 strict assert per test block) are flagged per-batch for
  follow-up; most are HTTP journey tests where a single test() block drives a
  multi-step flow with a handful of asserts — thin by the heuristic, not
  necessarily weak.
- Coverage surface: the slice is dominated by HTTP-contract suites (boot a
  real server via createRoomServer against a temp sqlite store) plus
  sqlite-backed unit suites; pure-logic suites are the minority.

## Per-batch index

- batch-1 … batch-10: findings/guild-09/docs/batch-N.md (alphabetical by suite
  name, ~88 suites each)

# Dead code / unreachable code — guild-06 (scripts-rest)

Policy: an entry appears here only with reachability evidence (who calls it,
or proof nobody does). Candidates from the tracks below; "not dead" notes
recorded where evidence says otherwise.

## Evidence sources used
- `runtime-import-closure.mjs`-style static scan over scripts/ + tests/ +
  .github/workflows references (2026-10-09).
- `scripts/untested-modules-lint.mjs` grandfather list (server-side, 15
  modules — not dead code, just untested; out of this slice anyway).
- Mutation track: `analytics-backfill.mjs` `copyTable()` — its return value is
  DISCARDED at its only call site (line 37: `await copyTable(...)`; the
  result is not read). Both return-value mutants equivalent. This is an
  **unobserved return contract**, not dead code: the function itself is
  called and performs its side effect (the table copy). Not dead.
- `scripts/candidate-manifest.mjs` imports guild-05's
  `scripts/runtime-package.mjs` read-only (verified import) — used, not dead.

## Verdict: no dead code found in the slice (2026-10-09)

Every script under scripts/ (excluding guild-05's `scripts/room`,
`scripts/*migrate*.mjs`, `scripts/runtime-package.mjs`) is reachable by at
least one of: a CI workflow job, an npm script, a sibling script import, a
test fixture/helper import, or a documented operator runbook invocation.

Near-misses (looked dead, aren't):
- `qa2/journeys.mjs` — single-line re-export alias for `agent-journeys.mjs`;
  kept deliberately as the acceptance entry point. Not dead.
- `scripts/room-digest` (extensionless) — reachable from room tooling; not dead.
- `telegram-contract-fixture.mjs`, `synthetic-mail-fixture.mjs`,
  `helpers/*` — test-only fixtures/helpers imported by browser checks and
  unified journeys. Reachable via tests.
- `scripts/runtime-import-closure.mjs` — used by the runtime-package
  allowlist lint tests. Reachable.

## Suspects that need a longer window (not declared dead)
- `scripts/snippet-adoption.mjs` — weekly cron job; runs rarely but is
  referenced by its workflow. Not dead.
- `scripts/weekly-learnings.mjs` — weekly cron; idempotency log in
  `~/.config/weekly-learnings/`. Not dead.
- `scripts/rotation-cutover.sh` / `rotation-rehearse.sh` — runbook tooling,
  executed rarely by design. Not dead.

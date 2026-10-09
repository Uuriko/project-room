# Test Infrastructure

Generated from code on 2026-10-09 (worktree `wave400/docs-tooling`). Covers helpers, fixtures,
harnesses, layout, and CI sharding — not the test cases themselves.

## Layout

- `tests/` — unit + integration tests (`node --test`), run sharded in CI.
- `tests/helpers/` — shared test helpers (1 file).
- `tests/fixtures/` — three fixture locations (no index — **discoverability gap**):
  `tests/fixtures/`, `scripts/*-fixture.mjs` (21 synthetic fixtures), and inline `createAcceptanceFixture`.
- 5 harnesses: the acceptance fixture (`createAcceptanceFixture` + in-process `createRoomServer`),
  the helper-agent exercise, the synthetic-mail double, the provider doubles
  (`gmail-live-fixture.mjs` — never contacts Google), and the journey harness.

## CI sharding & quarantine

Tests run sharded in CI; `tests/quarantine.json` lists quarantined tests, each entry carrying
an **owner** and a **repair-by date**. Quarantined tests are excluded from the gate but tracked.

## Fixture hygiene

Fixture headers uniformly stress "never production": disposable synthetic data, no provider reads,
no existing-DB opens, no deployed-entrypoint imports. One exception: `scripts/acceptance-fixture.mjs`
has no header.

## Notable test-only infrastructure

- `tests/inbox-outbox.test.js` "full pilot capacity": ~5000 sequential `inbox.apply()` calls each
  fsync under `PRAGMA synchronous=FULL` (~30ms/commit) — looks like a hang of the *next* test;
  test-only fix with `synchronous=NORMAL` on the disposable fixture DB.
- `tests/fixtures/route-permission-baseline.json` (244 lines, frozen 2026-10-06): freezes the set of
  mutating REST operations in `docs/openapi.yaml` that predate the `x-room-permission` requirement
  and still declare none. `tests/route-permission-declared.test.js` enforces: (1) new undeclared
  mutating ops fail CI (must declare a permission); (2) the baseline may only shrink; (3) declared
  permissions match `/^[a-z][a-z_]*(\|[a-z][a-z_]*)*$/`, sorted + unique. Verified exact at this HEAD:
  239 undeclared ops, 239 baseline entries, empty set difference both ways.
- `tests/runtime-package.test.js:62-70` pins the MCP tool-count ladder (currently 44 with
  `room_close_work_claim` present).
- `tests/docs-troubleshooting.test.js` grounds `docs/TROUBLESHOOTING.md` claims.
- `tests/openapi-method-accuracy.test.js` boots a live server for method-level contract checks.

## Browser test infrastructure

`scripts/*-browser-check.mjs` (~106 files) are Playwright `node:test` suites against a local
ephemeral server + fixture; off-origin network requests are aborted in tests (fail closed).
`npm run test:browser` runs them with `--test-concurrency=1`. Visual regression baselines live in
`scripts/visual-regression-baselines/`.

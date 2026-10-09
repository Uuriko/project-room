## Test layout

| Area | Files | Command |
|---|---|---|
| Unit | tests/*.test.js (node:test, default discovery) | `npm test` (= `node --test`; `pretest` runs check-deps.mjs) |
| Unit (sharded, CI) | Same files, split by scripts/unit-shards.mjs into balanced file shards | test.yml (unsharded run was ~625s, the long pole of every PR) |
| Quarantined | tests/quarantine.json entries, run separately | `npm run test:quarantined` (= run-quarantined-tests.mjs) |
| Browser | scripts/*-browser-check.mjs (Playwright, headless Chromium) | `npm run test:browser` (single-concurrency); `npm run test:browser:ci` (= browser-ci.mjs) in CI |
| Relay | relay/test/ | `npm run test:relay` |
| Machine | machine/test/machine.test.mjs | `npm run test:machine` |
| Handoff | tests/agent-handoff.test.js | `npm run test:handoff` |
| Evals | tests/evals-harness.test.js (QA2 BUILD-EVALS contract tests) | `node --test tests/evals-harness.test.js` |
| i18n | tests/i18n-harness.test.js | `node --test tests/i18n-harness.test.js` |

## CI sharding & reporting

- **test.yml**: the main suite; runs unit shards (unit-shards.mjs) + coverage thresholds + untested-modules lint + runtime-package checks. `ci-changes.mjs` decides which expensive suites a PR needs.
- **Browser job**: `browser-ci.mjs` wrapper + `browser-ci-reporter.mjs` (failures become GitHub annotations + per-script duration lines, so a red job names the script/test).
- **Failure reporting**: `scripts/report-test-failures.mjs` / `report-unit-failures.mjs` surface failures; `scripts/flaky-detect.mjs` is detection-only (runs a test file N times, parses TAP) and never gates CI.
- **Specialty workflows** (31 total in .github/workflows/): zero-bug-gates.yml (check-deps, check-deps-exist, secret scans), zero-bug-quarantine.yml, schema-gate.yml, qa2-*/qa3-gates.yml, mime-fuzz.yml, soak-test.yml, staging.yml, deploy-prod.yml, live-smoke.yml, etc.

## Quarantine flow

- **Where the list lives:** `tests/quarantine.json` — entries name the test (`"scripts/board-browser-check.mjs > <test name>"`), owner, quarantined_at, reason (with CI run IDs as evidence), and `repair_by` date.
- **How a test gets quarantined:** the test file itself `skip`s with reason `"quarantined: tests/quarantine.json (<reason>; repair by <date>)"` (in-file, e.g. board-browser-check.mjs:478); the blocking suite keeps the functional assertions. The quarantine.json entry is the durable record with owner + repair deadline.
- **How it gets un-quarantined:** repair the harness/flake, remove the skip and the quarantine.json entry. Repair-by dates are enforced by convention (entries above show 2026-10-19/20).
- **Quarantined run:** `npm run test:quarantined` runs the quarantined set separately so they still execute without gating merges.
- Note: `scripts/shadow-quarantine-report.mjs` is a different quarantine (spam-shadow auto-quarantine precision reports, AUTO-QUARANTINE-POLICY.md §5) — unrelated to test quarantine despite the name.

## Newcomer commands

1. `npm run verify:affected` — run only tests related to your diff (pre-push)
2. `npm run check` — the aggregator gate (lint, schema, secrets, route docs, wiki, links)
3. `npm test` — full unit suite
4. `node scripts/<name>-browser-check.mjs` — one browser check locally
5. `node scripts/flaky-detect.mjs <test-file> --runs=N` — is it flaky or broken?

### Behavioral notes
- The quarantine system is unusually disciplined: every entry carries owner, dated evidence, and a repair deadline; the blocking suite retains functional coverage so quarantine never silently drops assertions.
- Two different "quarantine" concepts (test quarantine vs spam-shadow quarantine) share a name — the docs should disambiguate.

### Stale flags
- None found in this slice.

### Suspected bugs
- None found in this slice.

DONE: 9 areas, CI sharding, quarantine flow, 0 stale flags, 0 suspected bugs

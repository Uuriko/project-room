## Test helpers

| File | Exports / API | Used by |
|---|---|---|
| tests/helpers/fake-webhook-dns.mjs | `fakePublicWebhookLookup(host)`, `fakeThrowingWebhookLookup(code)`, `fakeEmptyWebhookLookup()`, `installFakeWebhookDns(store, lookup)` — test-only DNS seam for the webhook SSRF gate | Suites registering fixture webhook URLs (https://*.test) via `store.agentPlugin.setWebhookLookup(...)` or passing `{ lookup }` to `assertSubscriptionWebhookUrl`. Production gate (server/outbound-webhooks.mjs `assertAgentWebhookUrlPublic`) is fully fail-closed with no reserved-name exemption; production never uses these fakes |

## Test fixtures

| File | What it contains | Used by |
|---|---|---|
| tests/fixtures/identity-mint-solver.mjs | Test solver for the identity-mint PoW challenge | tests/agent-self-onboarding.test.js, tests/mcp-identity-mint.test.js |
| tests/fixtures/route-permission-baseline.json | Pinned route→permission baseline (which routes require which auth) | tests/route-permission-declared.test.js |
| tests/fixtures/anon-auth-before-validation.json | Auth-ordering fixture (anonymous auth before validation) | (grep to confirm; name suggests auth-middleware ordering tests) |
| tests/fixtures/browser-junit-sample.xml | Sample JUnit XML for the browser CI reporter | browser-ci-reporter tests |
| tests/fixtures/pr-overlap-2026-09-26.json | PR-overlap scenario fixture (dated) | PR overlap/collision tests |
| tests/fixtures/suffix-fixtures.json | Suffix test fixtures | Suffix-handling tests |
| tests/fixtures/wazz-rings.json | "wazz rings" fixture (name unclear — no header found) | (grep to confirm) |
| tests/fixtures/flaky-detect/ | Fixture dir for flaky-detect | scripts/flaky-detect.mjs tests |
| tests/fixtures/unit-ci/ | Fixture dir for unit CI | unit sharding tests |

## Harnesses

| Harness | What it does | How to run | Pass criteria |
|---|---|---|---|
| tests/evals-harness.test.js | evals/ harness skeleton — failing-first contract tests (QA2 BUILD-EVALS); fail before the harness exists, pass after | `node --test tests/evals-harness.test.js` | Contract assertions hold |
| tests/i18n-harness.test.js | Tests for scripts/i18n-harness.mjs (Q012); carries test-audit authoring-gate answers | `node --test tests/i18n-harness.test.js` | i18n invariants hold |
| tests/acceptance-fixture.test.js | Acceptance fixture (no header comment) | `node --test tests/acceptance-fixture.test.js` | Fixture builds cleanly |
| tests/helper-agent-exercise.test.js | Helper agent exercise (no header comment) | `node --test tests/helper-agent-exercise.test.js` | Exercise completes |
| tests/room-cli-setup.test.js | Room CLI setup (no header comment) | `node --test tests/room-cli-setup.test.js` | Setup completes |

## How a new test gets fixture data

- The recommended path per the code: import from `tests/fixtures/` (JSON fixtures) or `tests/helpers/` (JS seams like the DNS fakes). Fixture webhook URLs use `https://*.test` and install `installFakeWebhookDns` — never hit real DNS.
- Identity-mint PoW in tests goes through `tests/fixtures/identity-mint-solver.mjs`, not the real solver.

### Behavioral notes
- The helpers directory is minimal (one file) — most test doubling lives in per-test fixtures or scripts/*-fixture.mjs instead. That's a discoverability gap for newcomers: there are three fixture locations (tests/fixtures/, tests/helpers/, scripts/*-fixture.mjs) with no index.
- Three harness-adjacent test files have no header comments (acceptance-fixture, helper-agent-exercise, room-cli-setup) — purpose must be inferred from the code.

### Stale flags
- None found in this slice.

### Suspected bugs
- None found in this slice.

DONE: 1 helper, 10 fixtures, 5 harnesses, 0 stale flags, 0 suspected bugs

# Testing

Three suites, three commands. Run in this order when iterating.

## 1. Unit + gates: `npm run check`

Syntax-checks every JS file, runs the journey-coverage gate, the
no-shadow-imports gate, then `node --test` (the `tests/` suite). This is
what the CI `contract` job runs. See [CONTRACT.md](CONTRACT.md).

Run one file: `node --test tests/agent-upgrade.test.js`
Run one test: `node --test --test-name-pattern="presence" tests/capabilities.test.js`

Note: `tests/agent-upgrade.test.js` needs the full git history (it checks
out pinned baseline commits). On a shallow clone it now tells you to run
`git fetch --unshallow` instead of failing cryptically.

## 2. Browser: `npm run test:browser`

Playwright UI checks against a real Chromium. First time only:

```sh
npx playwright install --with-deps chromium
```

Each `scripts/*-check.mjs` file is a standalone check that boots its own
server, drives the UI, and asserts. Run one file the same way:

```sh
node --test scripts/browser-check.mjs
```

Keep `--test-concurrency=1` when running the full suite — the checks bind
ports and share the display. Evidence artifacts land in `test-results/`
(uploaded by CI on every run).

## 3. Load: `node scripts/load-test.mjs [agents] [iterations]`

Spins N concurrent agents against the HTTP API (presence, post, claim,
changes, capabilities) and reports ops/sec + p50/p95/p99 latency.
See [LOAD-TEST-2026-09-12.md](LOAD-TEST-2026-09-12.md) for the baseline
numbers (~175 ops/sec, pilot caps: 100 members/room, 10k events).

## 4. Backup drill: `node scripts/backup-drill.mjs`

Proves a live room survives the sqlite backup round-trip (counts + content
compared after restore).

## What CI runs

`.github/workflows/test.yml`: `contract` (`npm run check`), `browser`
(`npm run test:browser`), `cloudflare` (Worker runtime checks). The
cloudflare job manually enumerates its `.check.mjs` files — keep that list
in sync when adding Worker checks.

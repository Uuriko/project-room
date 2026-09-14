# Testing

Three suites, three commands. Run in this order when iterating.

## 1. Unit + gates: `npm run check`

Syntax-checks every JS file, runs the journey-coverage gate, the
no-shadow-imports gate, the route-documentation gate
(`scripts/route-docs-check.mjs`: every served `/api` route template is in
`docs/openapi.yaml`), the schema-version gate, then `node --test` (the
`tests/` suite). This is what the CI `contract` job runs. See
[CONTRACT.md](CONTRACT.md).

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

CI runs `npm run test:browser:ci` instead: the same suite list (read from
`test:browser`, so there is one source of truth) with the `spec` reporter
on stdout and a `junit` file at `test-results/browser-junit.xml`. A
following `if: always()` step, `node scripts/report-test-failures.mjs`,
turns that file into one `::error` annotation per failed test and a
Markdown table in the job summary, so the failing test is readable through
the GitHub API even when the raw log and artifact are not reachable.

## 3. Load: `node scripts/load-test.mjs [agents] [iterations]`

Spins N concurrent agents against the HTTP API (presence, post, claim,
changes, capabilities) and reports ops/sec + p50/p95/p99 latency.
See [LOAD-TEST-2026-09-12.md](LOAD-TEST-2026-09-12.md) for the baseline
numbers (~175 ops/sec, pilot caps: 100 members/room, 10k events).

## 4. Backup drill: `node scripts/backup-drill.mjs`

Proves a live room survives the sqlite backup round-trip (counts + content
compared after restore).

## Cold start: `node scripts/measure-cold-start.mjs [phases|constructor] ...`

One script, two subcommands, `--json` for both. `phases [runs] [--no-miniflare]`
(the default) times import, fresh store, first request and store reopen under
Node (CPU and wall) and, when `cloudflare/node_modules` has miniflare, the same
requests against the real Worker entry (wall). `constructor [events] [runs]
[--help-history]` fills a store with N audit events and times cold `RoomStore`
constructions of it (min / median / max). Results and the reading against the
Worker CPU cap are in [WORKER-LIMITS.md](WORKER-LIMITS.md);
`tests/measure-cold-start.test.js` pins the CLI and both report shapes.

## Pre-push suggestion

Add a git pre-push hook that runs the fast path only (syntax + gates,
no unit tests):

```sh
# .git/hooks/pre-push
node scripts/check.mjs --fast
```

`--fast` is not implemented yet — today `npm run check` runs the full
unit suite too, which is too slow for a hook. Proposed: add a `--fast`
flag that stops after the three static gates (syntax, journey-coverage,
shadow-imports) and skips `node --test`. Full suite stays in CI.

`.github/workflows/test.yml`: `contract` (`npm run check`), `browser`
(`npm run test:browser:ci`, see section 2), `cloudflare` (Worker runtime checks). The
cloudflare job manually enumerates its `.check.mjs` files — keep that list
in sync when adding Worker checks.

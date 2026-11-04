# Flaky-Test Quarantine

A flaky test — one that fails non-deterministically while the product is fine — must **leave the blocking suite the same day it is identified**. Flakes rot signal: one red-but-meaningless test trains every lane to ignore CI. Quarantine keeps the red honest without silencing the test.

## The lifecycle

1. **Quarantine it today.** When a flake is confirmed (not "maybe", confirmed — fails at least once on a green tree), open a PR that (a) removes it from the blocking suite (skips it, or moves it out of the default `node --test` glob) and (b) appends an entry to `tests/quarantine.json`. Same PR, same day.
2. **Record the entry.** Shape:
   ```json
   {
     "test": "tests/worker-pool.test.js > drains on SIGTERM",
     "reason": "assert.throws timing: race between SIGTERM handler and drain loop (seen 3x on CI, never locally)",
     "owner": "quill",
     "quarantined_at": "2026-10-05",
     "repair_by": "2026-10-19"
   }
   ```
   `reason` is the failure signature, not a vibe — enough that a stranger can reproduce the flake. `repair_by` is at most 14 days after `quarantined_at`. `owner` is a lane or handle; it may be filled in by the repair lane within the 14-day window if unknown at quarantine time.
3. **While quarantined, the test runs in the non-blocking lane.** Quarantined tests are executed by `scripts/run-quarantined-tests.mjs` (`npm run test:quarantined`), which reads `tests/quarantine.json`. Entries identify tests either by file plus test name (`"file > test name"`) or by a bare file. The runner executes each test with `QUARANTINE_RUN=1`. A failing test produces a non-zero exit status from the local runner.

   In CI, `.github/workflows/pr-gates.yml` runs both:
   - **quarantine contract** (step in the `gates` job): validates the quarantine registry on pull requests and pushes to `main`.
   - **`quarantined-tests`**: executes the quarantined tests nightly and on manual dispatch. The job sets `continue-on-error: true`, so a failure reports without failing the workflow.

   Quarantined tests can be run locally using:
   ```sh
   bash scripts/test-env.sh npm run test:quarantined
   ```
4. **Repair or re-admit within 14 days.** The owner fixes the root cause (not the assertion — the race, the clock dependency, the shared fixture) and the test re-enters the blocking suite with its entry deleted. A genuinely unfixable test is re-admitted only as a deleted test: remove the entry and delete or permanently disable the test with the reason recorded in the PR, never as an indefinite quarantine.

## Shard proposals (TST-01B)

`scripts/flaky-merge.mjs` reads a directory or JSON file of shard records. Each record is a `flaky-detect` result: `file` plus `flaky` or `tests` rows of `{ name, passes, fails }`. When `tests` is present it is the complete count for that record; otherwise `flaky` is used. Counts for the same file and test name add across shards. A test is proposed only when the total has at least one pass and one fail. `shard-summary.json` is ignored.

The script prints `{"quarantined":[...]}` and does not edit `tests/quarantine.json`. `owner` is the last committer of the test file when git can name one. `repair_by` is 14 days after `--today` (default: the UTC date). Exit 1 means at least one proposal was printed. A person still opens the quarantine PR; the script does not skip the test.

## The enforcement

The `gates` job runs `scripts/quarantine-check.mjs` in CI on every PR and every push to `main`. It exits non-zero when any entry violates the contract:

- **past `repair_by`** — the 14 days are up, the test is not fixed, and nobody re-admitted or deleted it;
- **`quarantined_at` older than 14 days with no `owner`** — an ownerless flake quietly becoming permanent;
- malformed entries, unparseable dates, future `quarantined_at`, or `repair_by` beyond the 14-day cap.

Fix violations by doing the actual work (repair the test), not by editing dates. Extending a `repair_by` requires the reason field to say why and who agreed — and it still cannot exceed 14 days from `quarantined_at`.

## Deterministic time (TST-11)

A test that reads the wall clock while the code under test reads an injected clock can flake: a slow runner or an `advance()` moves one clock and not the other. Use `tests/helpers/test-clock.mjs`. `createTestClock()` gives the store and the assertions one clock (`new RoomStore(file, { now: clock.now })`, then assert against `clock.now()`). `freezeDate(t, at)` pins the global `Date` for one test when the code takes no clock; real `setTimeout` waits still run. First users: `tests/guest-join.test.js` (exact TTL on the store clock instead of a 60 s window) and `tests/claim-scopes.test.js`.

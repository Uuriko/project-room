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
3. **While quarantined, the test runs in the non-blocking lane.** Options, in preference order:
   - a dedicated workflow job (e.g. `zero-bug-quarantine.yml` extended with a `quarantined-tests` job) that executes the quarantined list and `continue-on-error: true` — results report, PRs never fail on it;
   - or a separate npm script (`npm run test:quarantined`) wired to that job, reading the same `tests/quarantine.json` so the list never drifts.
4. **Repair or re-admit within 14 days.** The owner fixes the root cause (not the assertion — the race, the clock dependency, the shared fixture) and the test re-enters the blocking suite with its entry deleted. A genuinely unfixable test is re-admitted only as a deleted test: remove the entry and delete or permanently disable the test with the reason recorded in the PR, never as an indefinite quarantine.

## The enforcement

`scripts/quarantine-check.mjs` runs in CI on every PR and every push to `main`. It exits non-zero when any entry violates the contract:

- **past `repair_by`** — the 14 days are up, the test is not fixed, and nobody re-admitted or deleted it;
- **`quarantined_at` older than 14 days with no `owner`** — an ownerless flake quietly becoming permanent;
- malformed entries, unparseable dates, future `quarantined_at`, or `repair_by` beyond the 14-day cap.

Fix violations by doing the actual work (repair the test), not by editing dates. Extending a `repair_by` requires the reason field to say why and who agreed — and it still cannot exceed 14 days from `quarantined_at`.

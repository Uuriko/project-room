# Browser CI shards

`package.json` → `scripts.test:browser` remains the only suite inventory.
Local `npm run test:browser` still runs that full list unchanged. CI runs four
isolated matrix jobs, each with the same checkout and one Chromium test file
at a time. Run a single shard locally with:

```sh
scripts/test-env.sh npm run test:browser:ci -- --shard=1/4
```

Use Node 24.19 or newer. Run all four shard indexes to cover the full suite;
a single green shard is not a full browser result. The wrapper rejects invalid
indexes, empty shards, duplicate paths and unsupported suite command syntax.
It executes Node directly, without a shell or interpolation of suite paths.

## Allocation and timing evidence

Node's built-in [`--test-shard`](https://nodejs.org/download/release/v24.19.0/docs/api/cli.html#--test-shard)
splits by file count. These suites vary substantially in duration, so
`scripts/browser-shards.mjs` instead assigns the longest estimated file first
to the least-loaded shard (stable filename and shard-index tie breaks).
Execution within each shard retains the canonical list's relative order.

`scripts/browser-ci-durations.json` records the timing source and revision:
[successful hosted run 36286526443](https://github.com/Uuriko/project-room/actions/runs/36286526443).
Its browser job took 14m38s including setup; 93 top-level script durations
sum to 788.1s. Generated wrapper filenames are attributed to their owning
suite. The initial allocation is 19/24/25/25 files, with estimated test times
197.1/197.0/197.0/197.0s. These are scheduling estimates, not promised speedups;
setup, worker availability and test changes affect actual elapsed time.

A new file automatically joins from `test:browser` with a 10s estimate. Removed
files disappear even if a stale timing entry remains. Refresh estimates from
a complete successful hosted run when imbalance warrants it; never remove
slow tests to improve a shard's time.

## Required result and evidence

The existing required check name **browser** remains an aggregate job.
The [matrix](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/run-job-variations)
uses `fail-fast: false`, so failures do not prevent siblings from producing
evidence. The aggregate uses [`if: always()`](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-jobs)
and refuses failure, cancellation, skip, missing dependency result, or any
missing/mismatched receipt. It requires all four exit-zero receipts bound to
the candidate SHA, workflow run ID, run attempt, complete allocation hash
and exact assigned file list. An Actions-level skipped job cannot pass via an
old successful receipt. Existing intentional test-level skips retain their
original Node semantics; this change does not alter individual assertions.

Each shard preserves spec output, the annotation/duration reporter, JUnit,
screenshots and other `test-results/` evidence. JUnit and receipt filenames
include the shard index. Artifact names include both shard index and run
attempt, avoiding immutable v4 artifact collisions on reruns. The aggregate
downloads only artifacts from its current run attempt; missing evidence fails
closed. Reporter and artifact steps run even after a failed test step.

**After a failure, choose “Re-run all jobs” in GitHub Actions.** “Re-run failed
jobs” retains successful siblings from an older attempt; their evidence is
intentionally rejected by the current-attempt gate. This trades a little
extra rerun time for a complete, auditable result without trusting stale
success artifacts.

`tests/browser-shards.test.js` runs real child test files through all four CLI
shards, checks exact-once execution and reporter output, injects a child
failure, and exercises stale/missing/failed aggregate evidence. It does not
replace hosted verification of GitHub's scheduling or branch-protection
configuration. No required checks or branch rules are changed here.

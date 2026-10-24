# Invariants telemetry contract

The record an invariant run leaves behind: where it lives, what each line
means, and how the evidence is preserved. This document describes the
contract **as implemented** by the harness, `scripts/invariants-ci.mjs`,
which is the producer. (The A14 design named a standalone
`scripts/invariants-reporter.mjs` and `scripts/invariants-report.mjs`;
neither is in the tree. The harness emits the results file and renders the
PR table itself, and only prefers `scripts/invariants-report.mjs` for
rendering if that file appears.)

## When it runs

`.github/workflows/invariants.yml` runs the harness on every pull request,
every push to `main`, merge-group checks, and manual dispatch. The same
command runs locally: `node scripts/invariants-ci.mjs`.

## Resolution order

- Results file: `$INVARIANTS_RESULTS_FILE`, else `results/invariants.jsonl`
  (CI sets a per-SHA path, `results/invariants-<sha>.jsonl`; `results/` is
  gitignored).
- Raw TAP file: `$INVARIANTS_TAP_FILE`, else the results path with the
  `.jsonl` suffix replaced by `.tap`.
- Repo SHA: `$INVARIANTS_SHA` > `git rev-parse HEAD` > `"unknown"`.

## Results file (JSONL)

One JSON object per line, appended synchronously so the file is readable
mid-run. Three line types:

- `run_start` — `run_id`, `repo_sha`, `harness`, `harness_version`,
  `started_at`.
- `invariant_result` — one per test, plus `run_id` and `repo_sha`:
  - `name` — the invariant id (stable kebab-case, matching the scenario
    ids in `tests/invariants/`), the slugified test name for harness
    self-tests, or `file:<basename>` for a file-level record (below).
  - `status` — `pass` | `fail` | `skip` | `error`.
  - `duration_ms`, `started_at`, `finished_at`.
  - `message` — for failures, the failure type and the error text. Every
    failure form Node emits is captured: AssertionError block scalars,
    plain-Error single-line scalars, and file-level load deaths.
  - On failure records, when the TAP stream carries them: `error_code`
    (e.g. `ERR_ASSERTION`, `ERR_TEST_FAILURE`), `stack` (first stack
    frame), and `exit_code`.
- `run_end` — `finished_at`, `duration_ms`, per-status `counts`, and the
  run `status` (`pass` only when nothing failed or errored).

A test file whose module graph throws at load reports no tests of its
own. Instead of being skipped silently, its failed aggregate line becomes
a named `file:<basename>` result with status `error`, carrying the exit
code and the error headline from the TAP `#` diagnostics that preceded
it. A file whose tests merely failed aggregates `not ok` too, but those
failures already have their own records — no `file:` record is added.

The gate fails closed: an unparsable TAP stream is a failed run, and if
the test runner exits nonzero while every parsed record passed, the
harness appends a synthetic `harness-runner` error record.

## Raw TAP

The complete captured TAP stream (stdout + stderr of `node --test`) is
written to the raw TAP file on every run. The parser is deliberately
lossy; the TAP file is the specimen of record and can be re-read without
it.

## Artifacts and comments (CI)

- The results JSONL and the raw TAP upload as one artifact named
  `invariants-results-<sha>-attempt-<n>`. A following workflow step
  verifies the artifact exists in the run's artifact listing and fails
  the job loudly if it does not — an upload step reporting success is
  not, by itself, proof the artifact is there.
- The results table posts as a PR comment beginning with the marker
  `<!-- invariants-ci -->`, keyed by run id and attempt
  (`<!-- invariants-ci run=<id> attempt=<n> -->`). A comment that
  reported FAIL is never deleted; only superseded non-FAIL comments are
  removed on re-run.

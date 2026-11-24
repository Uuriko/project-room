# Find and verify one CI improvement

Run this when a project has a slow check or when you need to decide whether a
check belongs on an agent's laptop. Use one existing Work Thread for the
observed wait, the change, the exact result, and the follow-up measurements.

## Execution plan

| Joggernaut skill | What to use in Project Room |
| --- | --- |
| Diagnose | Fetch a bounded history with Joggernaut's read-only collector. Use Room's report to follow the jobs that controlled completion, identify the biggest measured steps, and count compute on and off that chain. Save the run IDs, candidates, and eligibility filters. |
| Measure | Run the upstream cohort comparison on closed windows, with the same workflow, destination branch, and workload. Use its exact test-identity comparison with the real JUnit artifacts. Record failed attempts, incomplete reports, changed runner labels, and test parity separately. |
| Cache | If setup dominates the wait, inspect actual restore/save output by job. Compare warm and cold states for the same job and image. Measure the whole job and verify that the inputs and named test results agree. |
| Workflow | Count repeated setup and work spent on unsuccessful or superseded attempts. Test one change to job layout at a time. Measure the check that people wait for separately from aggregate runner time. |
| Slow tests | Use Room's existing per-suite timing data for the first replay. Keep full suite membership while testing balance or reuse between jobs. Recheck the real runner against the prior path. |
| Flaky tests | Treat a failure followed by a pass as a candidate flake. Check exact result identities and attempt history, then reproduce with the pinned command before making a fix. Keep the fix open when reproduction is inconclusive. |
| Guard | Run the existing local affected checks when local feedback is faster. Use the qualification receipt to decide what finished and what still needs the hosted environment. Keep any check that saves fewer minutes than it costs out of the developer's path. |

Start with a single high-cost cause. Use the Mac for a safe, warm feedback run
when it can reproduce the workload. Keep the hosted baseline for Linux,
browser versions, native dependencies, and any claim about GitHub Actions
wait. Save the exact candidate, runner label, command and named test evidence.
Run a matched hosted experiment with identical checks when a change is ready.
Treat branch and local measurements as provisional. Continue the comparison
on closed post-merge cohorts when there are enough comparable runs.

## Run a diagnosis

Use a checked-out [Joggernaut](https://github.com/usejog/joggernaut) source tree
to collect jobs and attempts and to run its statistical and JUnit comparison
tools. The implementation was qualified against revision
`ec88031835a50665f6ce9546ce2c5c640b5a495b`. No provider credentials beyond the existing GitHub
read access are needed for collection.

```sh
python3 /path/to/joggernaut/skills/ci-measure/scripts/measure.py fetch \
  --repo OWNER/REPO --workflow test.yml --limit 45 --out /tmp/pr-runs.jsonl
node scripts/ci-wait-report.mjs /tmp/pr-runs.jsonl > /tmp/ci-wait-report.json
```

Run the report from the repository the history belongs to. It reads the
workflow from the recorded Git head when that object is locally available.
It follows distinct static job names and matrix names derived from a static
template. A missing workflow, ambiguous name, or unobserved dependency falls
back to the last observed job, with the unresolved part explicit. Job start
delay is measured after its recorded prerequisites and job creation, when
those timestamps exist. The remainder includes workflow dispatch and gaps
without timing data. Step categories use names as hints. An install time is
evidence of waiting in that step, with cache misses or downloads diagnosed
from separate logs.

Use `--head FULL_SHA` for a specific PR revision. Add `--terminal NAME` to time
a specific check and `--require-job NAME` to
filter to comparable runs where a named job actually started. A run that
lacks the required job is counted in the report. When using a report to
compare full checks, require the coverage job or full shard set that defines
that cohort. Keep PR, main, and local measurements separate.

## Verify the result

Use the same pinned upstream script:

```sh
python3 /path/to/joggernaut/skills/ci-measure/scripts/measure.py compare \
  --before /tmp/before.jsonl --after /tmp/after.jsonl --base main --min-runs 20
python3 /path/to/joggernaut/skills/ci-measure/scripts/measure.py tests \
  --before /tmp/before-junit --after /tmp/after-junit
```

Record the median, slow tail, sample size, runner time, and failure rate.
Report timing and coverage as separate conclusions. Check each discovered
bottleneck against the same head and workflow before changing it. The path
is retrospective and overlapping savings estimates should be measured
together before making a combined claim.

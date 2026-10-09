# Gate G2: review-mechanical fork-safety — PR-code execution confinement

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## The concern
`review-mechanical.yml` runs on `pull_request` (opened/synchronize/reopened/edited)
and executes `node scripts/...` from the checkout. In `pull_request` context,
`actions/checkout@v4` without `ref` checks out the **PR merge commit** — i.e.
**untrusted code from a fork** runs in this workflow.

## Why it is safe (verified)

1. **Permissions**: top-level `contents: read, pull-requests: read, actions: read`.
   No `write` anywhere. The only credential is `GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}`
   — on a fork PR this is the read-only token.
2. **No other secrets injected** — verified: the workflow's only `secrets.*`
   reference is GITHUB_TOKEN. No deploy tokens, no room tokens.
3. **No artifact exfil path to a privileged context**: the job writes a job summary
   (`>> "$GITHUB_STEP_SUMMARY"`) and annotations — read-only sinks from the
   attacker's perspective.
4. The `workflow_run` leg (triggered by `test` completion) runs the **base branch's**
   workflow file with the base checkout (scripts from main, trusted); PR data enters
   only via `gh pr view` API output written to /tmp files — and the workflow_run
   leg additionally verifies `TESTED_SHA == CURRENT_HEAD` before pairing a test
   conclusion with a PR head (stale-run mismatch guard, lines 99-107).
5. PR body injection: `github.event.pull_request.body` → `PR_BODY` env → passed as
   `--body-file` to `scripts/review-scope-check.mjs` (file-mediated, not shell-
   interpolated — no command injection through the body).

## Same pattern holds for the other PR-triggered suites
test.yml, qa2-*, qa3-gates, zero-bug-gates/quarantine, machine, relay, pr-diff-size:
all run PR-head code under read-only permissions with no deploy/room secrets.
This is the correct least-privilege shape for fork-PR execution.

## Verdict: PASS — no fork-PR privilege escalation in the CI surface.

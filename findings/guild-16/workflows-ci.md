# CI / gate workflows

Generated 2026-10-09T11:16:33.034Z.

| workflow | triggers | concurrency guard | purpose |
|---|---|---|---|
| test.yml | pull_request,push,merge_group | yes | Pull requests each have their own group and cancel their own older runs. Pushes to main share `test-main` and  |
| schema-gate.yml | pull_request,push | yes | Schema convergence gate (bounty-propose-500 incident follow-up).  Post-#792 (2026-09-22), bounty propose 500'd |
| qa3-gates.yml | pull_request,schedule,workflow_dispatch | yes | Durable QA3 gates against a throwaway local server. Pull requests that touch the server, the client, or this h |
| zero-bug-gates.yml | pull_request | yes | Zero-bug gates (workstream 2a): agent-proof CI checks that BLOCK the PR.  Three jobs, each fails the workflow  |
| zero-bug-quarantine.yml | pull_request,push | yes | Zero-Bug: flaky-test quarantine gate A newer push to the same PR cancels the older run. |
| qa2-agent-eval.yml | pull_request,schedule,workflow_dispatch | yes | Agent-user eval suite against a throwaway local server (never production): synthetic agent journeys scored pas |
| qa2-fuzz.yml | schedule,workflow_dispatch | — | Nightly OpenAPI fuzzing (Schemathesis 4.x, stateful + coverage phases) against a throwaway local server. Gate: |
| qa2-synthetic.yml | schedule,workflow_dispatch | yes | Production synthetic monitoring for room.trydemigod.com, offset from live-smoke:  - stall probe: scripts/stall |

## Notes


### test.yml

- triggers: `pull_request,push,merge_group`
- concurrency group: `${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}', github.workflow, github.r`, cancel-in-progress: `${{ !(github.event_name == 'push' && github.ref == 'refs/heads/main') && github.event_name != 'workflow_dispatch' }}`
- jobs (11): changes, contract, visual-refresh-guard, lint, unit-shards, unit, browser-shards, browser, cloudflare, coverage, test

### schema-gate.yml

- triggers: `pull_request,push`
- concurrency group: `${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}', github.workflow, github.r`, cancel-in-progress: `${{ !(github.event_name == 'push' && github.ref == 'refs/heads/main') && github.event_name != 'workflow_dispatch' }}`
- jobs (1): schema-gate

### qa3-gates.yml

- triggers: `pull_request,schedule,workflow_dispatch`
- schedule: `17 8 * * *`
- concurrency group: `qa3-gates-${{ github.ref }}`, cancel-in-progress: `true`
- jobs (2): gates, board-growth

### zero-bug-gates.yml

- triggers: `pull_request`
- concurrency group: `${{ format('{0}-{1}', github.workflow, github.ref) }}`, cancel-in-progress: `true`
- jobs (3): sast, secrets, deps

### zero-bug-quarantine.yml

- triggers: `pull_request,push`
- concurrency group: `${{ github.workflow }}-${{ github.event.pull_request.number || (github.event_name == 'push' && githu`, cancel-in-progress: `${{ github.event_name == 'pull_request' }}`
- jobs (2): quarantine-check, quarantined-tests

### qa2-agent-eval.yml

- triggers: `pull_request,schedule,workflow_dispatch`
- schedule: `41 9 * * *`
- concurrency group: `${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}', github.workflow, github.r`, cancel-in-progress: `${{ github.event_name != 'workflow_dispatch' }}`
- jobs (2): changes, eval

### qa2-fuzz.yml

- triggers: `schedule,workflow_dispatch`
- schedule: `23 10 * * *`
- jobs (1): fuzz

### qa2-synthetic.yml

- triggers: `schedule,workflow_dispatch`
- schedule: `47 */6 * * *`
- concurrency group: `qa2-synthetic`, cancel-in-progress: `false`
- jobs (1): synthetic

## Gotchas

- The main-push concurrency guard (test.yml, schema-gate.yml): pushes to refs/heads/main share ONE group ('test-main') and NEVER cancel in-progress — the deploy-on-green starvation guard from #1371/#1375. PR runs cancel their own older runs. Restoring cancel-in-progress:true on main reintroduces deploy starvation (mutation m11 proves the test catches it).
- qa2-* scheduled runs are the deep checks; the 5-minute outage probe is a separate Worker (cloudflare/external-probe.wrangler.jsonc), not a workflow.
- zero-bug-quarantine.yml pins third-party actions to commit SHAs (2026-10-03 fix) — do not "upgrade" a pin to a floating tag.

# Secret flow S8: machine.yml + relay.yml secrets

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Findings

- `machine.yml`: triggers `pull_request` (paths: machine/**) + `push: [main]`. Top-level `contents: read`. Audit shows **no `secrets.*` references in the workflow file** (Secret references section empty). It builds/tests the agent-machine surface without credentials.
- `relay.yml`: triggers `pull_request` (paths: relay/**, machine/**, server/work-claim*.mjs) + `push: [main]`. Top-level `contents: read`. Audit shows **no `secrets.*` references**.

## Verdict

Clean. Neither workflow injects secrets, so neither is an exfiltration vector post-merge beyond the generic push-to-main surface (any future secret added here would be exposed by the CODEOWNERS hole — see gate-g5). Both run PR code (checkout of PR head on the `pull_request` leg) with read-only permissions: the correct confinement pattern.

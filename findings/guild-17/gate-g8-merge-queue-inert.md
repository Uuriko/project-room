# Gate G8: merge-queue workflows are inert — verified

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Evidence
- `merge-queue-receipts.yml` header: "INERT WITHOUT THE TAP — Trigger: ONLY
  `merge_group` events... until the queue is enabled this workflow can never run.
  Second gate: every job requires the repo variable MERGE_QUEUE_BOT == '1'
  (unset by default)."
- `merge-queue-eject-budget.yml`: same double gate (`merge_group` + `MERGE_QUEUE_BOT == '1'`).
- Both declare minimal permissions (receipts: `contents: read`; eject-budget:
  `contents: write` ledger-commit + `pull-requests: write` comment — needed only
  when the queue exists).

## Verdict: PASS. The merge-queue surface is doubly gated off (GitHub-side event
impossible without the queue; repo-variable gate unset). When/if the queue is
enabled, the eject-budget workflow's ledger-commit-back-to-main path
(contents:write on `pull_request: closed` + `merge_group: destroyed`) will need
a re-audit — it is fail-closed to one file (`tests/merge-queue-eject-budget.json`)
with `[skip ci]`, but that property was only verified by reading the header
comment, not the script. Flagging for the enabling PR's review checklist.

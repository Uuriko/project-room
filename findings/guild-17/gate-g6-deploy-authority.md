# Gate G6: deploy-prod auto-deploy semantics — who/what can ship to production

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Trigger surface (deploy-prod.yml, verified in source)

1. **workflow_dispatch** (manual): input `sha` must be a full 40-hex commit that
   is an ancestor of main. Caller needs `actions: write` (workflow-dispatch rights)
   on the repo. The run REFUSES unless the `test` and `schema-gate` **push** runs
   on that exact SHA both concluded `success` (deploy-prod.yml gate job).
2. **workflow_run** (auto): fires when `test` or `schema-gate` completes on main,
   but the gate job proceeds ONLY if:
   - `vars.ROOM_AUTO_DEPLOY == '1'` **OR** the workflow_run's display title starts
     with `[deploy-production]` (i.e. the squash-merge commit title, which is the
     PR title), AND
   - conclusion is `success`, event is `push`, head_branch is `main`, AND
   - the SHA is still the main tip, AND production does not already report that SHA.
3. **Onboarding gate** (optional): when `vars.ROOM_ONBOARDING_GATE == '1'`, a probe
   job runs the onboarding probe against staging and blocks on regression; a
   dispatch can override with `probe_override` + reason (recorded in receipt).

## Security observations

- The `[deploy-production]` title trigger is **social, not cryptographic**: anyone
  who can get a PR merged (advisory reviews — see G5) controls the squash-merge
  title and can therefore arm auto-deploy for their own commit. This is the
  documented design (the header comment describes it openly), and the dual-green
  gate + tip check still apply. The trust boundary is the merge gate, not the
  title.
- `workflow_dispatch` requires write-level repo access; it does NOT require any
  additional approval. Any collaborator with dispatch rights can deploy any
  dual-green main commit. Documented in the workflow header ("any agent or person
  with workflow-dispatch rights on this repo can ship a green main commit to
  production"). This matches John's standing delegation (agents ship; taps only
  for money/identity) — recording as design, not finding.
- Concurrency `production-deploy`, `cancel-in-progress: false`: deploys serialize;
  a started deploy is never cancelled mid-flight. Good.
- Receipt: posts to muse-room when `ROOM_RECEIPT_TOKEN` exists (optional).

## Verdict: design verified and self-consistent. The trust boundary is the merge
gate (required CI + conversation resolution). No new finding.

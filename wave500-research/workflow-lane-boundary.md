# Boundary: WAVE-400 workflow lane vs WAVE-500 protocol lane

Checked 2026-10-08: `git ls-remote --heads origin` shows **no** `wave400/workflow`
branch yet (only `wave400/audit`, `wave400/elegant-server`). The workflow lane
(coordinator 7/8, WORKFLOW EFFECTIVENESS ANALYTICS) is in flight; its outputs
are expected as `WORKFLOW-METRICS.md` + protocol-tweak proposals on a future
`wave400/workflow` branch.

## Theirs (workflow lane — extend, don't duplicate)

- Measuring claim cycle times, stall points, lease-expiry rate, collision rate,
  real onboarding time (2-minute rule), time-to-first-receipt.
- Concrete protocol *tweaks* from measured friction (e.g. onboarding cuts).
- The metrics dashboard itself.

## Ours (protocol lane — this work)

- The 500-agent **message hierarchy**: spine vs guild-local taxonomy, budgets.
- **Broadcast/subscription discipline** replacing broadcast-everything.
- **Claim namespacing conventions** + board search UX at swarm scale.
- **Failure handling**: orphan reclamation at scale, wave ABORT protocol.
- **Rollup message formats** (machine-readable, stamp-at-write).
- Simulations quantifying event-budget impact.

## Shared — how we coordinate

- If their metrics contradict our budgets (e.g. real events/lifecycle ≠ 6.5),
  their numbers win; our sims get re-run with their inputs.
- Their onboarding findings feed our mint-budget rule (don't mint during waves).
- Overlap procedure: first-claim-wins on doc files; if they publish a
  conflicting protocol tweak, we reconcile in the room before either merges.
  Neither lane edits the other's branch.

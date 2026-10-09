# Secret flow S7: GITHUB_TOKEN usage across all workflows
_head 6efe5fdbe_

## Reference lines
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:92:          GH_TOKEN: ${{ github.token }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/deploy-prod.yml:250:          GITHUB_TOKEN: ${{ github.token }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/listing-check.yml:24:          GITHUB_TOKEN: ${{ github.token }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/live-smoke.yml:36:          GITHUB_TOKEN: ${{ github.token }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/merge-queue-eject-budget.yml:69:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/review-mechanical.yml:56:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/review-mechanical.yml:91:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/room-github-door.yml:53:          GITHUB_TOKEN: ${{ github.token }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/snippet-adoption.yml:5:# with no write permission. Without it the job tries GITHUB_TOKEN and exits 0
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/snippet-adoption.yml:34:          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/staging.yml:99:          GITHUB_TOKEN: ${{ github.token }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/test.yml:154:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:12:# Why a PAT and not GITHUB_TOKEN: GitHub suppresses workflow runs for
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:13:# GITHUB_TOKEN-caused events (anti-recursion), so a PR opened with
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:14:# GITHUB_TOKEN would never launch the required status checks and could never
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:16:# (Validated 2026-10-06: PR #1650, opened with a non-GITHUB_TOKEN credential,
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:22:# warning annotation (it never falls back to GITHUB_TOKEN — that would
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:82:            echo "the TRACE_ENTRY_TOKEN repo secret. GITHUB_TOKEN cannot be"
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:83:            echo "used: GitHub suppresses workflow runs for GITHUB_TOKEN-caused"
  /home/hatch/workspace/pr-wave1000-guild-17/.github/workflows/trace-entry.yml:106:          # PAT (not GITHUB_TOKEN): the push must trigger workflows normally.

## Job-level permissions declared per workflow (bounding the token)
== answer-engine-check.yml:
  permissions:
== deploy-drift.yml:
  permissions:
== deploy-prod.yml:
  permissions:
== listing-check.yml:
  permissions:
== live-smoke.yml:
  permissions:
== machine.yml:
  permissions:
== mcp-registry-publish.yml:
  permissions:
== merge-queue-eject-budget.yml:
  permissions:
== merge-queue-receipts.yml:
  permissions:
== mime-fuzz.yml:
  permissions:
== onboarding-probe.yml:
  permissions:
== pr-diff-size.yml:
  permissions:
== qa2-agent-eval.yml:
  permissions:
== qa2-fuzz.yml:
  permissions:
== qa2-synthetic.yml:
  permissions:
== qa3-gates.yml:
  permissions:
== relay.yml:
  permissions:
== review-mechanical.yml:
  permissions:
== rollback-prod.yml:
  permissions:
== room-github-door.yml:
  permissions:
== room-work-sync.yml:
  permissions:
== schema-gate.yml:
  permissions:
== snippet-adoption.yml:
  permissions:
== soak-test.yml:
  permissions:
== staging.yml:
  permissions:
== stall-probe.yml:
  permissions:
== test.yml:
  permissions:
== trace-entry.yml:
  permissions:
== visual-baselines.yml:
== zero-bug-gates.yml:
  permissions:
== zero-bug-quarantine.yml:

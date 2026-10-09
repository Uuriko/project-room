# Secret flow S9: room-work-sync / onboarding-probe / prod-probe secrets

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## room-work-sync.yml (pull_request_target: closed, merged PRs with 'Room-Work:' in body)
- Injects `ROOM_DOOR_SECRET` (room-github-door.yml audit §Secret references: line 30).
- `pull_request_target` runs the **base branch's** workflow file in base context —
  the merged PR's code is never executed (the workflow only reads PR metadata and
  posts a room receipt). Contents: read. Correct confinement for a
  pull_request_target workflow.

## onboarding-probe.yml (schedule + workflow_dispatch, targets production/staging)
- Audit shows no `secrets.*` injection in the workflow file itself. It probes
  public onboarding flows; no credentials needed. Clean.

## qa2-synthetic.yml / live-smoke.yml (production probing)
- `qa2-synthetic.yml`: hits `https://room.trydemigod.com` with public journeys;
  creates throwaway rooms/identities, then archives/revokes them. Workflow has
  `contents: read`; audit shows no secrets injected (the journey uses the public
  API). Clean.
- `live-smoke.yml`: injects `GITHUB_TOKEN` (audit line 36) for API reads;
  schedule + dispatch only. No deploy secrets. Clean.

## trace-entry.yml bot-PR pattern (cross-check)
- Uses `TRACE_ENTRY_TOKEN` PAT (contents:write + pull-requests:write, repo-wide)
  to push `trace-entry/*` branches and open PRs. The workflow constrains the push
  to the `trace-entry/` prefix by code (not by token scope) — noted in S7.
- The trace PRs go through the normal merge gate (required checks), so the bot
  cannot bypass CI. Verified: header says the trace PR "is squash-merged only
  after GitHub reports it mergeable (required checks green)".

## Verdict: PASS. All prod-touching probe workflows are credential-free or
read-scoped; the one write-capable token (TRACE_ENTRY_TOKEN) is confined by
workflow code to trace-entry branches and its PRs still pass the merge gate.

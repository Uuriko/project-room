# Workflow audit: soak-test.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    # Weekly bounded soak: Mondays 09:00 UTC.
    - cron: "0 9 * * 1"
  workflow_dispatch:
    inputs:
      duration_s:
        description: "Soak duration in seconds (900 = 15 min; CI caps at ~50 min)"
        required: false
        default: "900"

permissions:

## Top-level permissions
14:permissions:
15-  contents: read
16-
17-# PRs each have their own group and cancel their own older runs.
18-concurrency:
19-  group: ${{ github.event_name == 'workflow_dispatch' && format('{0}-dispatch-{1}', github.workflow, github.run_id) || format('{0}-{1}', github.workflow, github.ref) }}
20-  cancel-in-progress: ${{ github.event_name != 'workflow_dispatch' }}

## Actions used (pinning)
  27:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  28:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  43:        uses: actions/upload-artifact@b5c5fca5f78071c0d17c0d02a9e0dcf5e5e1 # v4

## Third-party action pin check
  [SHA-PINNED] 27:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 28:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [UNPINNED/BRANCH] 43:        uses: actions/upload-artifact@b5c5fca5f78071c0d17c0d02a9e0dcf5e5e1 # v4

## Secret references

## Runs-on / environment
  18:concurrency:
  24:    runs-on: ubuntu-latest

## Risk notes
  - interacts with artifacts or PR comments (check secret leakage)

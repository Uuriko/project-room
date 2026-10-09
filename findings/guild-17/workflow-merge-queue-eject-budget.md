# Workflow audit: merge-queue-eject-budget.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  merge_group:
    types: [destroyed]
  pull_request:
    types: [closed]

permissions:

## Top-level permissions
39:permissions:
40-  contents: write      # ledger commit back to main (fail-closed to one path)
41-  pull-requests: write # over-budget comment on the tripped PR only
42-
43-# Serialize ledger commits; a queued run sees the previous run's push.
44-concurrency:
45-  group: merge-queue-eject-budget

## Actions used (pinning)
  53:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  56:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 53:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 56:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  63:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  69:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

## Runs-on / environment
  44:concurrency:
  51:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - grants write permission somewhere (see uses/permissions)

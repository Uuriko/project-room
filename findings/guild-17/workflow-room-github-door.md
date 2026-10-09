# Workflow audit: room-github-door.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  issue_comment:
    types: [created]
  schedule:
    - cron: "*/10 * * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
15:permissions:
16-  contents: read
17-  issues: write
18-
19-concurrency:
20-  group: room-github-door-${{ github.event_name == 'issue_comment' && 'in' || 'out' }}
21-  cancel-in-progress: false

## Actions used (pinning)
  28:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  31:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  47:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  48:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 28:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 31:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 47:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 48:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  37:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  55:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}

## Runs-on / environment
  19:concurrency:
  26:    runs-on: ubuntu-latest
  45:    runs-on: ubuntu-latest

## Risk notes
  - grants write permission somewhere (see uses/permissions)

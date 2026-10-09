# Workflow audit: room-work-sync.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request_target:
    types: [closed]

permissions:

## Top-level permissions
13:permissions:
14-  contents: read
15-
16-jobs:
17-  sync:
18-    if: github.event.pull_request.merged == true && contains(github.event.pull_request.body, 'Room-Work:')
19-    runs-on: ubuntu-latest

## Actions used (pinning)
  21:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  24:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 21:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 24:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  30:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}

## Runs-on / environment
  19:    runs-on: ubuntu-latest

## Risk notes

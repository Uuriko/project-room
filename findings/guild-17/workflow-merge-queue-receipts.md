# Workflow audit: merge-queue-receipts.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  merge_group:
    types: [checks_requested, destroyed]

permissions:

## Top-level permissions
22:permissions:
23-  contents: read
24-
25-jobs:
26-  validating:
27-    if: vars.MERGE_QUEUE_BOT == '1' && github.event.action == 'checks_requested'
28-    runs-on: ubuntu-latest

## Actions used (pinning)
  30:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  33:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  47:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  50:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 30:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 33:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 47:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 50:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  39:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}
  56:          ROOM_DOOR_SECRET: ${{ secrets.ROOM_DOOR_SECRET }}

## Runs-on / environment
  28:    runs-on: ubuntu-latest
  45:    runs-on: ubuntu-latest

## Risk notes

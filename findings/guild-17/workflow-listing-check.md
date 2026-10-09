# Workflow audit: listing-check.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "0 14 * * 1"
  workflow_dispatch:

permissions:

## Top-level permissions
10:permissions:
11-  contents: read
12-
13-jobs:
14-  listing-check:
15-    runs-on: ubuntu-latest
16-    timeout-minutes: 15

## Actions used (pinning)
  18:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  19:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  29:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 18:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 19:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 29:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references
  25:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}

## Runs-on / environment
  15:    runs-on: ubuntu-latest

## Risk notes
  - interacts with artifacts or PR comments (check secret leakage)

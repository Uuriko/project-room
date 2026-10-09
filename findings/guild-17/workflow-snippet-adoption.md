# Workflow audit: snippet-adoption.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "0 13 * * 1"
  workflow_dispatch:

permissions:

## Top-level permissions
12:permissions:
13-  contents: read
14-  actions: read
15-
16-concurrency:
17-  group: snippet-adoption
18-  cancel-in-progress: false

## Actions used (pinning)
  25:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  26:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  39:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 25:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 26:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 39:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references
  33:          ADOPTION_SEARCH_TOKEN: ${{ secrets.ADOPTION_SEARCH_TOKEN }}
  34:          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  35:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  36:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
  37:          ANALYTICS_INGEST_TOKEN: ${{ secrets.ANALYTICS_INGEST_TOKEN }}

## Runs-on / environment
  16:concurrency:
  22:    runs-on: ubuntu-latest

## Risk notes
  - grants write permission somewhere (see uses/permissions)
  - interacts with artifacts or PR comments (check secret leakage)

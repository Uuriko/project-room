# Workflow audit: answer-engine-check.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "0 15 * * 1"
  workflow_dispatch:

permissions:

## Top-level permissions
12:permissions:
13-  contents: read
14-
15-concurrency:
16-  group: answer-engine-check
17-  cancel-in-progress: false
18-

## Actions used (pinning)
  24:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  25:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  40:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 24:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 25:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 40:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references
  32:          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
  33:          ANTHROPIC_API_KEY: ${{ secrets.ANTHROPIC_API_KEY }}
  34:          PERPLEXITY_API_KEY: ${{ secrets.PERPLEXITY_API_KEY }}
  35:          XAI_API_KEY: ${{ secrets.XAI_API_KEY }}
  36:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  37:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}
  38:          ANALYTICS_INGEST_TOKEN: ${{ secrets.ANALYTICS_INGEST_TOKEN }}

## Runs-on / environment
  15:concurrency:
  21:    runs-on: ubuntu-latest

## Risk notes
  - interacts with artifacts or PR comments (check secret leakage)

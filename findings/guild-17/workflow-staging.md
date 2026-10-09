# Workflow audit: staging.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  push:
    branches: [main]
  workflow_dispatch:

permissions:

## Top-level permissions
14:permissions:
15-  contents: read
16-
17-concurrency:
18-  group: staging-deploy
19-  cancel-in-progress: false
20-

## Actions used (pinning)
  26:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  27:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  55:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
  101:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 26:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 27:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 55:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
  [SHA-PINNED] 101:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references
  33:          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  34:          SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  67:          CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  68:          CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  69:          ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}

## Runs-on / environment
  17:concurrency:
  23:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - interacts with artifacts or PR comments (check secret leakage)

# Workflow audit: rollback-prod.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  workflow_dispatch:
    inputs:
      prod_version_id:
        description: "project-room (canonical) version id to restore"
        required: true
        type: string
      entry_version_id:
        description: "project-room-staging (public entry) version id to restore; leave empty to keep the entry as is"
        required: false
        type: string
      reason:
        description: "Why (goes into the Cloudflare rollback message and the receipt)"
        required: true
        type: string

permissions:

## Top-level permissions
24:permissions:
25-  contents: read
26-
27-concurrency:
28-  group: production-deploy
29-  cancel-in-progress: false
30-

## Actions used (pinning)
  58:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  59:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  62:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4

## Third-party action pin check
  [SHA-PINNED] 58:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 59:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 62:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4

## Secret references
  42:      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  43:      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  106:          ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}

## Runs-on / environment
  27:concurrency:
  39:    runs-on: ubuntu-latest

## Risk notes

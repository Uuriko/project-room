# Workflow audit: deploy-prod.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  workflow_dispatch:
    inputs:
      sha:
        description: "Full 40-character commit SHA on main (test + schema-gate must be green)"
        required: true
        type: string
      reason:
        description: "Optional note for the receipt"
        required: false
        type: string
      probe_override:
        description: "Only when ROOM_ONBOARDING_GATE is 1: deploy even if the staging onboarding probe fails, recording this reason"
        required: false
        type: string
  workflow_run:
    workflows: [test, schema-gate]
    types: [completed]
    branches: [main]

permissions:

## Top-level permissions
56:permissions:
57-  contents: read
58-  actions: read
59-
60-# One production change at a time. Never cancel a deploy that has started.
61-concurrency:
62-  group: production-deploy

## Actions used (pinning)
  86:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  141:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  144:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  163:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  201:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  205:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  208:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
  216:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  259:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 86:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 141:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 144:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 163:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  [SHA-PINNED] 201:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 205:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 208:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
  [SHA-PINNED] 216:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  [SHA-PINNED] 259:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references
  184:      CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
  185:      CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
  189:          SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  225:          ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  236:          ROOM_AGENT_CARD_SIGNING_KEY: ${{ secrets.ROOM_AGENT_CARD_SIGNING_KEY }}
  271:          ROOM_RECEIPT_TOKEN: ${{ secrets.ROOM_RECEIPT_TOKEN }}

## Runs-on / environment
  61:concurrency:
  80:    runs-on: ubuntu-latest
  135:    runs-on: ubuntu-latest
  180:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - interacts with artifacts or PR comments (check secret leakage)

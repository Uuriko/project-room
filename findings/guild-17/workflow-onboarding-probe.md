# Workflow audit: onboarding-probe.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "0 15 * * 1"
  workflow_dispatch:
    inputs:
      target:
        description: production or staging
        required: true
        default: production
        type: choice
        options:
          - production
          - staging

permissions:

## Top-level permissions
17:permissions:
18-  contents: read
19-
20-jobs:
21-  probe:
22-    runs-on: ubuntu-latest
23-    timeout-minutes: 30

## Actions used (pinning)
  27:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  28:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  69:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  91:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  92:      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4

## Third-party action pin check
  [SHA-PINNED] 27:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 28:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 69:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  [SHA-PINNED] 91:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 92:      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4

## Secret references
  53:          ROOM_OPS_POST_TOKEN: ${{ secrets.ROOM_OPS_POST_TOKEN }}
  54:          ROOM_OPS_ROOM_ID: ${{ secrets.ROOM_OPS_ROOM_ID }}

## Runs-on / environment
  22:    runs-on: ubuntu-latest
  86:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - grants write permission somewhere (see uses/permissions)
  - interacts with artifacts or PR comments (check secret leakage)

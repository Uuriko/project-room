# Workflow audit: qa2-synthetic.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "47 */6 * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
16:permissions:
17-  contents: read
18-
19-concurrency:
20-  group: qa2-synthetic
21-  cancel-in-progress: false
22-

## Actions used (pinning)
  28:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  29:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  46:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 28:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 29:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 46:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references

## Runs-on / environment
  19:concurrency:
  25:    runs-on: ubuntu-latest

## Risk notes
  - interacts with artifacts or PR comments (check secret leakage)

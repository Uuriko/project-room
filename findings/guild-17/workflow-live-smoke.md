# Workflow audit: live-smoke.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "17 */6 * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
15:permissions:
16-  contents: read
17-
18-concurrency:
19-  group: live-smoke
20-  cancel-in-progress: false
21-

## Actions used (pinning)
  27:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  28:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 27:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 28:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  18:concurrency:
  24:    runs-on: ubuntu-latest

## Risk notes
  - grants write permission somewhere (see uses/permissions)

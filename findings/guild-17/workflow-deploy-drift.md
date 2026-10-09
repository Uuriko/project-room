# Workflow audit: deploy-drift.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "23 * * * *"
  workflow_dispatch:
    inputs:
      max_prs:
        description: Fail when production is behind main by more than this many commits
        default: "5"
        required: false
      max_hours:
        description: Fail when the first of those commits is older than this many hours
        default: "24"
        required: false

permissions:

## Top-level permissions
20:permissions:
21-  contents: read
22-
23-concurrency:
24-  group: deploy-drift
25-  cancel-in-progress: false
26-

## Actions used (pinning)
  32:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  35:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 32:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 35:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  23:concurrency:
  29:    runs-on: ubuntu-latest

## Risk notes

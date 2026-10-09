# Workflow audit: review-mechanical.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]
  # Completed test runs provide final conclusions without occupying a runner
  # while the independent test workflow is queued or running.
  workflow_run:
    workflows: ["test"]
    types: [completed]

permissions:

## Top-level permissions
29:permissions:
30-  contents: read
31-  pull-requests: read
32-  actions: read
33-
34-# One mechanical report per PR; a newer push or a finished test run replaces
35-# the older one. workflow_run dispatches are keyed by run id.

## Actions used (pinning)
  48:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  51:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  83:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  86:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 48:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 51:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 83:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 86:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  56:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
  91:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

## Runs-on / environment
  36:concurrency:
  45:    runs-on: ubuntu-latest
  80:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)

# Workflow audit: zero-bug-quarantine.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
  push:
    branches: [main]

# A newer push to the same PR cancels the older run.
concurrency:
  group: ${{ github.workflow }}-${{ github.event.pull_request.number || (github.event_name == 'push' && github.ref) || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:

## Top-level permissions

## Actions used (pinning)
  20:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  21:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  40:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  41:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 20:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 21:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 40:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 41:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  11:concurrency:
  17:    runs-on: ubuntu-latest
  34:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)

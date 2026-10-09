# Workflow audit: pr-diff-size.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
    types: [opened, synchronize, reopened, edited]

permissions:

## Top-level permissions
11:permissions:
12-  contents: read
13-
14-concurrency:
15-  group: ${{ github.workflow }}-${{ github.ref }}
16-  cancel-in-progress: true
17-

## Actions used (pinning)
  23:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  26:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 23:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 26:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  14:concurrency:
  20:    runs-on: ubuntu-latest

## Risk notes

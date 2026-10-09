# Workflow audit: trace-entry.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request_target:
    types: [closed]

permissions:

## Top-level permissions
45:permissions:
46-  contents: read
47-
48-concurrency:
49-  group: trace-entry-main
50-  cancel-in-progress: false
51-

## Actions used (pinning)
  64:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  67:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 64:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 67:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  73:          GH_TOKEN: ${{ secrets.TRACE_ENTRY_TOKEN }}
  79:            echo "trace-entry: secrets.TRACE_ENTRY_TOKEN is not set."
  113:          GH_TOKEN: ${{ secrets.TRACE_ENTRY_TOKEN }}

## Runs-on / environment
  48:concurrency:
  58:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - grants write permission somewhere (see uses/permissions)

# Workflow audit: machine.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
    paths:
      - "machine/**"
      - ".github/workflows/machine.yml"
      - "package.json"
  push:
    branches: [main]
    paths:
      - "machine/**"
      - ".github/workflows/machine.yml"
      - "package.json"

permissions:

## Top-level permissions
16:permissions:
17-  contents: read
18-
19-concurrency:
20-  group: ${{ github.workflow }}-pr-${{ github.event.pull_request.number || github.run_id }}
21-  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
22-

## Actions used (pinning)
  28:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  29:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  39:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  40:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 28:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 29:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 39:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 40:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  19:concurrency:
  25:    runs-on: ubuntu-latest
  36:    runs-on: macos-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)

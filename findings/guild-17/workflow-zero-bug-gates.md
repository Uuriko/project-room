# Workflow audit: zero-bug-gates.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:

permissions:

## Top-level permissions
19:permissions:
20-  contents: read
21-
22-concurrency:
23-  group: ${{ format('{0}-{1}', github.workflow, github.ref) }}
24-  cancel-in-progress: true
25-

## Actions used (pinning)
  32:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  33:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  54:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  57:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  74:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  75:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 32:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 33:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 54:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 57:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 74:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 75:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  65:      - run: node scripts/scan-secrets.mjs --base "$BASE_SHA"

## Runs-on / environment
  22:concurrency:
  29:    runs-on: ubuntu-latest
  51:    runs-on: ubuntu-latest
  71:    runs-on: ubuntu-latest

## Risk notes

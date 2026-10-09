# Workflow audit: qa3-gates.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
    paths:
      - "server/**"
      - "src/**"
      - "cloudflare/**"
      - "scripts/qa2/**"
      - "scripts/qa3/**"
      - "package.json"
      - ".github/workflows/qa3-gates.yml"
  schedule:
    - cron: "17 8 * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
21:permissions:
22-  contents: read
23-
24-concurrency:
25-  group: qa3-gates-${{ github.ref }}
26-  cancel-in-progress: true
27-

## Actions used (pinning)
  34:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  35:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  57:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  58:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 34:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 35:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 57:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 58:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  24:concurrency:
  31:    runs-on: ubuntu-latest
  54:    runs-on: ubuntu-latest

## Risk notes

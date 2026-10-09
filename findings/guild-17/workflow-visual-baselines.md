# Workflow audit: visual-baselines.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  workflow_dispatch:

jobs:

## Top-level permissions

## Actions used (pinning)
  23:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  24:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  32:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 23:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 24:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 32:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references

## Runs-on / environment
  20:    runs-on: ubuntu-latest

## Risk notes
  - interacts with artifacts or PR comments (check secret leakage)

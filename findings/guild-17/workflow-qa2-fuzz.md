# Workflow audit: qa2-fuzz.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  schedule:
    - cron: "23 10 * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
11:permissions:
12-  contents: read
13-
14-jobs:
15-  fuzz:
16-    runs-on: ubuntu-latest
17-    timeout-minutes: 30

## Actions used (pinning)
  19:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  20:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  23:      - uses: astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e # v6
  26:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 19:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 20:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 23:      - uses: astral-sh/setup-uv@d0cc045d04ccac9d8b7881df0226f9e82c39688e # v6
  [SHA-PINNED] 26:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references

## Runs-on / environment
  16:    runs-on: ubuntu-latest

## Risk notes
  - interacts with artifacts or PR comments (check secret leakage)

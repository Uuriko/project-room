# Workflow audit: test.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
  push:
    branches: [main]
  merge_group:
    types: [checks_requested]

permissions:

## Top-level permissions
10:permissions:
11-  contents: read
12-
13-# Pull requests each have their own group and cancel their own older runs.
14-# Pushes to main share `test-main` and do not cancel the run already in
15-# progress: GitHub finishes that main SHA and keeps only the newest pending
16-# run (any older pending run in the group is cancelled). A main SHA can

## Actions used (pinning)
  36:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  49:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  52:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  68:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  81:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  82:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  110:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  113:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  156:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  171:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  172:      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
  196:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  199:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  207:      - uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
  220:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  242:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  244:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  248:      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
  268:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  271:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  275:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
  282:      - uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
  305:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  331:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  334:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 36:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 49:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 52:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 68:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 81:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 82:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 110:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 113:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 156:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  [SHA-PINNED] 171:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 172:      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
  [SHA-PINNED] 196:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 199:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 207:      - uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
  [SHA-PINNED] 220:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  [SHA-PINNED] 242:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 244:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 248:      - uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093 # v4
  [SHA-PINNED] 268:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 271:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 275:      - uses: pnpm/action-setup@b906affcce14559ad1aafd4ab0e942779e9f58b1 # v4
  [SHA-PINNED] 282:      - uses: actions/cache@5a3ec84eff668545956fd18022155c47e93e2684 # v4.2.3
  [SHA-PINNED] 305:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4
  [SHA-PINNED] 331:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 334:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references
  154:          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}

## Runs-on / environment
  19:concurrency:
  30:    runs-on: ubuntu-latest
  46:    runs-on: ubuntu-latest
  65:    runs-on: ubuntu-latest
  78:    runs-on: ubuntu-latest
  100:    runs-on: ubuntu-latest
  168:    runs-on: ubuntu-latest
  189:    runs-on: ubuntu-latest
  231:    runs-on: ubuntu-latest
  265:    runs-on: ubuntu-latest
  328:    runs-on: ubuntu-latest
  370:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - grants write permission somewhere (see uses/permissions)
  - interacts with artifacts or PR comments (check secret leakage)

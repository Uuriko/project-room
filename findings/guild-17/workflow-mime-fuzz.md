# Workflow audit: mime-fuzz.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  # PRs run the sweep only when the parser or its harness changes (the seed
  # corpus still runs in `npm test` on every PR). Main pushes and the nightly
  # deep pass stay unfiltered, so a regression from any file is still caught.
  pull_request:
    paths:
      - "server/mime-message.mjs"
      - "scripts/fuzz-mime.mjs"
      - "tests/mime-fuzz*"
      - "tests/fuzz/mime-corpus/**"
      - ".github/workflows/mime-fuzz.yml"
  push:
    branches: [main]
  schedule:
    - cron: "41 7 * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
32:permissions:
33-  contents: read
34-
35-# A newer push to the same PR cancels the older sweep.
36-concurrency:
37-  group: ${{ github.workflow }}-${{ github.event.pull_request.number || (github.event_name == 'push' && github.ref) || github.run_id }}
38-  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

## Actions used (pinning)
  45:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  46:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  62:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Third-party action pin check
  [SHA-PINNED] 45:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 46:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4
  [SHA-PINNED] 62:      - uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02 # v4

## Secret references

## Runs-on / environment
  36:concurrency:
  42:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - interacts with artifacts or PR comments (check secret leakage)

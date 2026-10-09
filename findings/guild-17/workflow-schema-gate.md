# Workflow audit: schema-gate.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
  push:
    branches: [main]

permissions:

## Top-level permissions
26:permissions:
27-  contents: read
28-
29-# Pull requests each have their own group (workflow name plus ref) and cancel
30-# their own older runs. Pushes to main share that same ref key, because every
31-# main push uses refs/heads/main, and do not cancel the run already in
32-# progress. The running main SHA can finish, and only the newest pending main

## Actions used (pinning)
  44:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  45:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 44:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 45:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  35:concurrency:
  41:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)

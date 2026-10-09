# Workflow audit: stall-probe.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  workflow_dispatch:
    inputs:
      url:
        description: Origin to probe (no path)
        required: true
        default: https://room.trydemigod.com
      seconds:
        description: How many requests to fire, one per second
        required: true
        default: "20"
      path:
        description: Path on that origin
        required: true
        default: /api/ready
      max_ms:
        description: Fail when p99 latency exceeds this many milliseconds
        required: true
        default: "3000"

permissions:

## Top-level permissions
23:permissions:
24-  contents: read
25-
26-jobs:
27-  probe:
28-    runs-on: ubuntu-latest
29-    timeout-minutes: 10

## Actions used (pinning)
  31:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  32:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 31:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 32:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  28:    runs-on: ubuntu-latest

## Risk notes

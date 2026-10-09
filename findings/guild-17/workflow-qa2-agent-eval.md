# Workflow audit: qa2-agent-eval.yml
_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Triggers (verbatim 'on:' block)
on:
  pull_request:
    # Coarse prefilter on the pushing commit. Merge commits still match when
    # main touched these paths; jobs.changes re-checks the merge-base diff
    # (scripts/ci-changes.mjs EVAL_PATTERNS — keep the two lists in sync).
    paths: ["server/**", "src/**", "deploy/**", "cloudflare/**", "server.mjs", "scripts/qa2/**", "tests/qa2/**", "openapi*", "package*.json"]
  schedule:
    - cron: "41 9 * * *"
  workflow_dispatch:

permissions:

## Top-level permissions
18:permissions:
19-  contents: read
20-
21-# One in-flight run per pull request and per ref. A newer push cancels
22-# superseded queued and in-progress runs; the newest run stays.
23-# workflow_dispatch is keyed by run id so a manual run stays independent.
24-concurrency:

## Actions used (pinning)
  36:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  53:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  54:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Third-party action pin check
  [SHA-PINNED] 36:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 53:      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
  [SHA-PINNED] 54:      - uses: actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020 # v4

## Secret references

## Runs-on / environment
  24:concurrency:
  31:    runs-on: ubuntu-latest
  50:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
3:# Agent-user eval suite against a throwaway local server (never production):
34:      eval: ${{ steps.plan.outputs.eval }}
47:    # Skip only when the merge-base diff explicitly misses the eval paths.

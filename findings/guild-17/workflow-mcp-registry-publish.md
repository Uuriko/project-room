# Workflow audit: mcp-registry-publish.yml
_date: 2026-10-08 · guild-17 ci-deploy · head 6efe5fdbe_

## Triggers (verbatim 'on:' block)
on:
  push:
    tags: ["v*"]
    branches: [main]
  workflow_dispatch:

# Burst merges push main many times. Keep one run and at most one pending
# per ref (GitHub drops older pending runs); a running publish is never cut.
concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: false

permissions:

## Top-level permissions
26:permissions:
27-  id-token: write # Required for mcp-publisher login github-oidc
28-  contents: read
29-
30-jobs:
31-  publish:
32-    runs-on: ubuntu-latest

## Actions used (pinning)
  34:      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

## Third-party action pin check
  [SHA-PINNED] 34:      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

## Secret references

## Runs-on / environment
  22:concurrency:
  32:    runs-on: ubuntu-latest

## Risk notes
  - RUNS ON PUSH TO MAIN (post-merge exposure surface)
  - grants write permission somewhere (see uses/permissions)

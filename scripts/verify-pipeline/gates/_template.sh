#!/usr/bin/env bash
# _template.sh — NOT executed (leading underscore, not executable).
# Copy to gates/<your-gate-name>, chmod +x, implement the check.
#
# Contract: invoked as <gate> <repoDir> <baseSha> <headSha>.
# Print ONE JSON object to stdout, exit 0:
#   {"name": "<gate-name>", "pass": true|false,
#    "violations": [{"file": "...", "key": "...", "occurrences": 2,
#                    "introducedByMerge": true}],
#    "detail": "one-line human summary"}
# Non-zero exit / invalid JSON / timeout => gate infra error ("gate-error").
set -euo pipefail

REPO_DIR="$1"   # candidate's scratch worktree (head tree)
BASE_SHA="$2"
HEAD_SHA="$3"
NAME="template"

VIOLATIONS="[]"   # build with jq/python as needed
PASS=true
DETAIL="ok"

# Example scoping: only inspect files the candidate changed:
#   git -C "$REPO_DIR" diff --name-only "$BASE_SHA" "$HEAD_SHA" -- .

printf '{"name":"%s","pass":%s,"violations":%s,"detail":"%s"}\n' \
  "$NAME" "$PASS" "$VIOLATIONS" "$DETAIL"

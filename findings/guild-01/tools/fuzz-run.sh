#!/bin/bash
# fuzz-run.sh <F1..F15> — one fuzz unit on the pristine worktree (no repo mutation).
set -u
CASE="$1"
BASE="$HOME/workspace/pr-wave1000-guild-01"
OUT="$BASE/findings/guild-01/fuzz-raw/$CASE.txt"
mkdir -p "$BASE/findings/guild-01/fuzz-raw" "$BASE/.tmp"
{
  echo "FUZZ $CASE"
  if TMPDIR="$BASE/.tmp" timeout 180 node "$BASE/findings/guild-01/tools/fuzz-g01.mjs" "$BASE" "$CASE" 2>&1; then
    echo "VERDICT: PASS (no invariant violations)"
  else
    code=$?
    echo "VERDICT: FINDINGS (exit $code)"
  fi
} >"$OUT" 2>&1
grep -E "^(FUZZ|VERDICT|[A-Z0-9]+: inputs)" "$OUT"

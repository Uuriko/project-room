#!/bin/bash
# Re-run specific break specs in an existing scratch worktree. Args: UNIT WT SPECIDX...
set -u
UNIT="$1"; WT="$2"; shift 2
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SPECS="$ROOT/findings/guild-08/breakspec.json"
cd "$WT"
for IDX in "$@"; do
  SUITE=$(node -e "console.log(require('$SPECS')[$IDX].suite)")
  TARGET=$(node -e "console.log(require('$SPECS')[$IDX].target)")
  DESC=$(node -e "console.log(require('$SPECS')[$IDX].desc)")
  git checkout -q -- "$TARGET"
  APPLIED=$(node "$ROOT/findings/guild-08/apply-break.mjs" "$SPECS" "$IDX" "$WT/$TARGET")
  LOG="$WT/.tmp/rebreak-$IDX.log"
  TMPDIR="$WT/.tmp" timeout 570 node --test "tests/$SUITE" > "$LOG" 2>&1
  P=$(grep -oE 'ℹ pass [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
  F=$(grep -oE 'ℹ fail [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
  R="green"; [ "${F:-0}" -gt 0 ] 2>/dev/null && R="red"
  git checkout -q -- "$TARGET"
  echo "REBREAK $UNIT $SUITE -> $R (pass=${P:-?} fail=${F:-?}) :: $DESC [$APPLIED]"
done

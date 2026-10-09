#!/bin/bash
# M-unit batch: run mutants M<a>-M<b> sequentially in one scratch worktree. Args: WTNAME LO HI
set -u
WTNAME="$1"; LO="$2"; HI="$3"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WT="$ROOT/.scratch/$WTNAME"
git worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$WT"
git worktree add --detach "$WT" wave1000/guild-08 >/dev/null 2>&1 || { echo "mut: worktree add failed"; exit 1; }
ln -sfn "$ROOT/node_modules" "$WT/node_modules"
mkdir -p "$WT/.tmp"
SPECS="$ROOT/findings/guild-08/mutspec.json"
for i in $(seq $LO $HI); do
  ID=$(node -e "console.log(require('$SPECS')[$i].id)")
  SUITE=$(node -e "console.log(require('$SPECS')[$i].suite)")
  TARGET=$(node -e "console.log(require('$SPECS')[$i].target)")
  DESC=$(node -e "console.log(require('$SPECS')[$i].desc)")
  cd "$WT" && git checkout -q -- "$TARGET"
  APPLIED=$(node "$ROOT/findings/guild-08/apply-mut.mjs" "$SPECS" "$i" "$WT/$TARGET")
  LOG="$WT/.tmp/mut-$ID.log"
  if [ "$APPLIED" = "NOOP" ]; then R="mut-noop"; P="?"; F="?";
  else
    cd "$WT" && TMPDIR="$WT/.tmp" timeout 570 node --test "tests/$SUITE" > "$LOG" 2>&1
    P=$(grep -oE 'ℹ pass [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
    F=$(grep -oE 'ℹ fail [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
    R="killed"; [ "${F:-0}" -eq 0 ] 2>/dev/null && R="SURVIVED"
  fi
  cd "$WT" && git checkout -q -- "$TARGET"
  echo "MUT $ID $SUITE -> $R (pass=${P:-?} fail=${F:-?}) :: $DESC [$APPLIED]" | tee -a "$ROOT/findings/guild-08/mut-results.txt"
done
echo "mut batch $WTNAME done"

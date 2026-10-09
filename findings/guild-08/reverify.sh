#!/bin/bash
# R-unit: rebase scratch copy of a wave branch onto origin/main, run slice suites, review diff.
set -u
UNIT="$1"; BRANCH="$2"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WT="$ROOT/.scratch/rv-$UNIT"
git worktree remove --force "$WT" >/dev/null 2>&1; rm -rf "$WT"
git worktree add --detach "$WT" "$BRANCH" >/dev/null 2>&1 || { echo "$UNIT: worktree add failed for $BRANCH"; exit 1; }
ln -sfn "$ROOT/node_modules" "$WT/node_modules"
mkdir -p "$WT/.tmp"
cd "$WT"
git checkout -q -b "rv-$UNIT-scratch" 2>/dev/null
REBASED="yes"; CONFLICT=""
if ! git rebase origin/main >/dev/null 2>&1; then
  CONFLICT=$(git diff --name-only --diff-filter=U | tr '\n' ' ')
  git rebase --abort >/dev/null 2>&1
  REBASED="no (conflicts: $CONFLICT)"
fi
BASE_SHA=$(git rev-parse --short HEAD)
JSFILES=$(cd "$ROOT" && grep -v '\.sh$' findings/guild-08/files.txt | sed 's|^|tests/|' | tr '\n' ' ')
LOG="$WT/.tmp/reverify.log"
cd "$WT" && TMPDIR="$WT/.tmp" timeout 3000 node --test $JSFILES > "$LOG" 2>&1
P=$(grep -oE 'ℹ pass [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
F=$(grep -oE 'ℹ fail [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
C=$(grep -oE 'ℹ cancelled [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
DIFFSTAT=$(cd "$ROOT" && git diff --stat origin/main..."rv-$UNIT-scratch" 2>/dev/null | tail -3 | tr '\n' '|')
# adversarial review: list changed source vs test files
CHANGED=$(cd "$ROOT" && git diff --name-only origin/main..."rv-$UNIT-scratch" 2>/dev/null | grep -E "claim|room" | head -20 | tr '\n' ';')
node -e 'console.log(JSON.stringify({unit:process.argv[1],branch:process.argv[2],rebased:process.argv[3],head:process.argv[4],pass:process.argv[5],fail:process.argv[6],cancelled:process.argv[7],changed:process.argv[8]},null,1))' "$UNIT" "$BRANCH" "$REBASED" "$BASE_SHA" "${P:-0}" "${F:-0}" "${C:-0}" "$CHANGED" > "$ROOT/findings/guild-08/reverify-$UNIT.json"
echo "$UNIT $BRANCH rebased=$REBASED head=$BASE_SHA pass=${P:-?} fail=${F:-?} cancelled=${C:-?}"

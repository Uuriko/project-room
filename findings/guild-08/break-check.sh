#!/bin/bash
# H17-H20: deliberate-break fail-first checks in a scratch worktree. Args: UNIT_ID
set -u
UNIT="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
WT="$ROOT/.scratch/wt-$UNIT"
git worktree remove --force "$WT" >/dev/null 2>&1
rm -rf "$WT"
git worktree add --detach "$WT" wave1000/guild-08 >/dev/null 2>&1 || { echo "$UNIT: worktree add failed"; exit 1; }
ln -sfn "$ROOT/node_modules" "$WT/node_modules"
mkdir -p "$WT/.tmp"
OUT="$ROOT/findings/guild-08/break-$UNIT.json"
SPECS="$ROOT/findings/guild-08/breakspec.json"
echo "[" > "$OUT.tmp"
FIRST=1
COUNT=$(node -e "console.log(require('$SPECS').filter(s=>s.unit==='$UNIT').length)")
for i in $(seq 0 $((COUNT-1))); do
  GI=$(node -e "const s=require('$SPECS');console.log(s.findIndex(x=>x.unit==='$UNIT'))")
  IDX=$((GI + i))
  SUITE=$(node -e "console.log(require('$SPECS')[$IDX].suite)")
  TARGET=$(node -e "console.log(require('$SPECS')[$IDX].target)")
  DESC=$(node -e "console.log(require('$SPECS')[$IDX].desc)")
  cd "$WT" && git checkout -q -- "$TARGET"
  APPLIED=$(node "$ROOT/findings/guild-08/apply-break.mjs" "$SPECS" "$IDX" "$WT/$TARGET")
  if [ "$APPLIED" = "NOOP" ]; then
    RESULT="break-noop"; PASS=null; FAIL=null; NOTE="pattern did not match"
  else
    LOG="$WT/.tmp/break-$i.log"
    cd "$WT" && TMPDIR="$WT/.tmp" timeout 570 node --test "tests/$SUITE" > "$LOG" 2>&1
    P=$(grep -oE 'ℹ pass [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
    F=$(grep -oE 'ℹ fail [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
    C=$(grep -oE 'ℹ cancelled [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
    if [ "${F:-0}" -gt 0 ] 2>/dev/null; then RESULT="red"; else RESULT="green"; fi
    PASS="${P:-0}"; FAIL="${F:-0}"; NOTE="cancelled=${C:-0}"
  fi
  cd "$WT" && git checkout -q -- "$TARGET"
  [ $FIRST -eq 0 ] && echo "," >> "$OUT.tmp"
  FIRST=0
  node -e 'const d=process.argv[1];console.log(JSON.stringify({unit:process.argv[2],suite:process.argv[3],target:process.argv[4],desc:d,result:process.argv[5],pass:process.argv[6]==="null"?null:+process.argv[6],fail:process.argv[7]==="null"?null:+process.argv[7],note:process.argv[8]},null,1))' "$DESC" "$UNIT" "$SUITE" "$TARGET" "$RESULT" "$PASS" "$FAIL" "$NOTE" >> "$OUT.tmp"
  echo "$UNIT [$((i+1))/$COUNT] $SUITE -> $RESULT (pass=$PASS fail=$FAIL) :: $DESC"
done
echo "]" >> "$OUT.tmp"
mv "$OUT.tmp" "$OUT"
echo "$UNIT break-checks complete"

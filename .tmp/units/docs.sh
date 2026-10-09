#!/bin/bash
# docs.sh <unit> — run one docs unit. Writes markdown under
# ~/workspace/findings/guild-11/. Writes .tmp/units/results/dNN.txt.
W=~/workspace/pr-wave1000-guild-11
export TMPDIR=$W/.tmp
OUT=$W/findings/guild-11
mkdir -p "$OUT/docs"
cd "$W" || exit 1
U=$1
RES=$W/.tmp/units/results/${U}.txt
LOG=$W/.tmp/units/${U}.testlog
timeout 120 node "$W/.tmp/units/d/${U}.mjs" "$OUT" >"$LOG" 2>&1; CODE=$?
{
  echo "unit=$U"; echo "exit=$CODE"
  if [ "$CODE" -eq 0 ]; then echo "outcome=PASS"; else echo "outcome=FAIL"; fi
  echo "done=$(date -u +%FT%TZ)"
  tail -3 "$LOG"
} > "$RES"
exit 0

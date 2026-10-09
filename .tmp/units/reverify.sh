#!/bin/bash
# reverify.sh <unit> — run one re-verify unit. Writes .tmp/units/results/rNN.txt.
W=~/workspace/pr-wave1000-guild-11
export TMPDIR=$W/.tmp
cd "$W" || exit 1
U=$1
RES=$W/.tmp/units/results/${U}.txt
LOG=$W/.tmp/units/${U}.testlog
if [ "$U" = "r08" ]; then
  bash "$W/.tmp/units/r/r08.sh" >"$LOG" 2>&1; CODE=$?
else
  timeout 600 node "$W/.tmp/units/r/${U}.mjs" >"$LOG" 2>&1; CODE=$?
fi
{
  echo "unit=$U"
  echo "exit=$CODE"
  if [ "$CODE" -eq 0 ]; then echo "outcome=PASS"; else echo "outcome=FAIL"; fi
  echo "done=$(date -u +%FT%TZ)"
  echo "--- tail ---"
  tail -6 "$LOG"
} > "$RES"
exit 0

#!/bin/bash
# fuzz.sh <unit> — run one fuzz unit against the PRISTINE snapshot (race-free
# vs mutation units). Writes .tmp/units/results/fNN.txt.
W=~/workspace/pr-wave1000-guild-11
export TMPDIR=$W/.tmp
cd "$W" || exit 1
U=$1
RES=$W/.tmp/units/results/${U}.txt
LOG=$W/.tmp/units/${U}.testlog
{
  echo "unit=$U"
  timeout 600 node "$W/.tmp/units/f/${U}.mjs" >"$LOG" 2>&1
  CODE=$?
  echo "exit=$CODE"
  if [ "$CODE" -eq 0 ]; then echo "outcome=PASS"; else echo "outcome=FAIL"; fi
  echo "done=$(date -u +%FT%TZ)"
} > "$RES"
tail -3 "$LOG" >> "$RES"
exit 0

#!/bin/bash
# H-unit: baseline run + weak-assertion scan for one batch. Args: UNIT_ID (e.g. H01)
set -u
UNIT="$1"
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TMPDIR="$ROOT/.tmp"
cd "$ROOT"
JSFILES=$(node -e "const b=require('./findings/guild-08/batches.json');const u=b.find(x=>x.id==='$UNIT');console.log(u.files.filter(f=>!f.endsWith('.sh')).map(f=>'tests/'+f).join(' '))")
ALLFILES=$(node -e "const b=require('./findings/guild-08/batches.json');const u=b.find(x=>x.id==='$UNIT');console.log(u.files.map(f=>'tests/'+f).join(' '))")
OUT="$ROOT/findings/guild-08/results-$UNIT.json"
LOG="$ROOT/findings/guild-08/results-$UNIT.log"
echo "=== $UNIT baseline $(date -u +%FT%TZ) ===" > "$LOG"
node --test $JSFILES >> "$LOG" 2>&1
BASE_EXIT=$?
INTERRUPTED=$(grep -c 'Interrupted while running' "$LOG")
PASS=$(grep -oE 'ℹ pass [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
FAIL=$(grep -oE 'ℹ fail [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
CANC=$(grep -oE 'ℹ cancelled [0-9]+' "$LOG" | tail -1 | awk '{print $3}')
node findings/guild-08/weak-scan.mjs $ALLFILES > "$ROOT/findings/guild-08/weak-$UNIT.json" 2>/dev/null
WEAK_TOTAL=$(node -e "const w=require('./findings/guild-08/weak-$UNIT.json');console.log(w.reduce((a,f)=>a+f.weak.length,0))" 2>/dev/null || echo 0)
TEST_TOTAL=$(node -e "const w=require('./findings/guild-08/weak-$UNIT.json');console.log(w.reduce((a,f)=>a+f.tests,0))" 2>/dev/null || echo 0)
echo "{\"unit\":\"$UNIT\",\"baseline_exit\":$BASE_EXIT,\"interrupted\":$INTERRUPTED,\"pass\":${PASS:-0},\"fail\":${FAIL:-0},\"cancelled\":${CANC:-0},\"tests_scanned\":${TEST_TOTAL:-0},\"weak_flagged\":${WEAK_TOTAL:-0},\"files\":$(node -e "const b=require('./findings/guild-08/batches.json');const u=b.find(x=>x.id==='$UNIT');console.log(JSON.stringify(u.files))")}" > "$OUT"
echo "$UNIT done: pass=${PASS:-?} fail=${FAIL:-?} cancelled=${CANC:-?} weak=${WEAK_TOTAL:-?} interrupted=$INTERRUPTED"

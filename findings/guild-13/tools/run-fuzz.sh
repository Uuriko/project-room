#!/bin/bash
# run-fuzz.sh fN — run one fuzz unit, log output, append to ledger.
set -u
N="$1"
WT=~/workspace/pr-wave1000-guild-13
export G13_WT="$WT" TMPDIR="$WT/.tmp"
LOG="$WT/findings/guild-13/logs/$N.log"
OUT=$(timeout 150 node "$WT/findings/guild-13/tools/fuzz.mjs" "$N" 2>"$WT/findings/guild-13/logs/$N.err")
CODE=$?
echo "$OUT" > "$LOG"
export OUT
ROW=$(python3 - <<'EOF'
import json, os
out = os.environ.get("OUT", "").strip()
try:
    d = json.loads(out)
    unit = d.get("unit", "?")
    status = "PASS" if d.get("pass") else "FAIL"
    detail = (d.get("name", "") + ": " + d.get("detail", "")).replace("\t", " ")[:280]
except Exception:
    unit, status, detail = "?", "ERROR", "no/invalid JSON output"
print(f"{unit}\tfuzz\t{status}\t{detail}")
EOF
)
export ROW
flock "$WT/.tmp/ledger.lock" bash -c 'printf "%s\n" "$ROW" >> '"$WT"'/findings/guild-13/ledger.tsv'
echo "fuzz $N exit=$CODE -> $ROW"

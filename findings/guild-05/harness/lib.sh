#!/usr/bin/env bash
# guild-05 shared unit harness.
# Each unit: bounded command, writes one JSONL record to findings/guild-05/units.jsonl
set -uo pipefail
REPO="$HOME/workspace/pr-wave1000-guild-05"
G05="$HOME/workspace/findings/guild-05"
UNITLOG="$G05/units.jsonl"
mkdir -p "$G05" "$REPO/.tmp"
touch "$UNITLOG"

# record <unit> <track> <status:pass|fail|bug|gap> <detail-json-escaped-one-line>
record() {
  local unit="$1" track="$2" status="$3" detail="$4"
  local ts; ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  python3 - "$UNITLOG" "$unit" "$track" "$status" "$detail" "$ts" <<'EOF'
import json,sys
log,unit,track,status,detail,ts = sys.argv[1],sys.argv[2],sys.argv[3],sys.argv[4],sys.argv[5],sys.argv[6]
with open(log,'a') as f: f.write(json.dumps({"ts":ts,"unit":unit,"track":track,"status":status,"detail":detail})+"\n")
EOF
}

# sandbox <name> -> prints path; sets TMPDIR-safe dir
sandbox() {
  local d="$REPO/.tmp/guild05-$1"
  rm -rf "$d"; mkdir -p "$d"
  printf '%s' "$d"
}

# apply_mut <file> <old> <new> : python replace-first, asserts exactly 1 hit
apply_mut() {
  python3 - "$1" "$2" "$3" <<'EOF'
import sys
p,old,new = sys.argv[1],sys.argv[2],sys.argv[3]
s = open(p).read()
n = s.count(old)
assert n == 1, f"mutation anchor found {n} times in {p}"
open(p,'w').write(s.replace(old,new,1))
print("mutant applied")
EOF
}

# run_node_test <sandbox> <testfile...> : TMPDIR-local, 240s cap, prints tail
run_node_test() {
  local s="$1"; shift
  ( cd "$s" && TMPDIR="$s/.tmp" mkdir -p "$s/.tmp" && timeout 240 node --test "$@" 2>&1 | tail -12 )
}

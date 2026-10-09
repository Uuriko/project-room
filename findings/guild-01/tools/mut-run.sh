#!/bin/bash
# mut-run.sh <ID> — one mutation unit: disposable worktree, apply mutant, run mapped tests, record, clean up.
set -u
ID="$1"
BASE="$HOME/workspace/pr-wave1000-guild-01"
WT="$HOME/workspace/pr-g01-mut-$ID"
OUT="$BASE/findings/guild-01/mutants-raw/$ID.txt"
mkdir -p "$BASE/findings/guild-01/mutants-raw" "$BASE/.tmp"

cleanup() { git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1 || true; }
trap cleanup EXIT

git -C "$BASE" worktree add -f "$WT" -b "g01mut-$ID" wave1000/guild-01 >/dev/null 2>&1 || {
  git -C "$BASE" worktree add -f "$WT" -b "g01mut-$ID-$(date +%s)" wave1000/guild-01 >/dev/null 2>&1; }
{
  echo "MUTANT $ID"
  python3 - "$WT" "$BASE/findings/guild-01/tools/mut-spec.json" "$ID" <<'EOF'
import json, sys
wt, spec_path, mid = sys.argv[1], sys.argv[2], sys.argv[3]
spec = json.load(open(spec_path))[mid]
path = f"{wt}/{spec['file']}"
src = open(path).read()
n = src.count(spec["old"])
assert n >= 1, f"old string found {n} times, expected >=1"
src = src.replace(spec["old"], spec["new"], spec.get("count", 1))
open(path, "w").write(src)
print(f"file: {spec['file']}")
print(f"desc: {spec['desc']}")
print(f"occurrences replaced: {min(n, spec.get('count',1))} of {n}")
print(f"tests: {', '.join(spec['tests'])}")
EOF
  echo "--- diff ---"
  git -C "$WT" diff --stat
  git -C "$WT" diff | head -40
  echo "--- tests ---"
  mkdir -p "$WT/.tmp"
  KILLED=0
  TESTS=$(python3 -c "import json,sys; print(' '.join(json.load(open('$BASE/findings/guild-01/tools/mut-spec.json'))['$ID']['tests']))")
  for t in $TESTS; do
    if [ ! -f "$WT/$t" ]; then echo "MISSING TEST FILE: $t"; KILLED=1; continue; fi
    if TMPDIR="$WT/.tmp" timeout 300 node --test "$WT/$t" >"$WT/.tmp/tap.log" 2>&1; then
      echo "PASS: $t"
    else
      echo "FAIL: $t"
      KILLED=1
    fi
    tail -12 "$WT/.tmp/tap.log" | grep -E "^(ℹ (pass|fail)|not ok|# )" | head -6
  done
  if [ "$KILLED" = "1" ]; then echo "VERDICT: KILLED (suite failed)"; else echo "VERDICT: SURVIVED (suite green)"; fi
} >"$OUT" 2>&1
cat "$OUT" | grep -E "^(MUTANT|VERDICT|file:|desc:)"

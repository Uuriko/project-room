#!/usr/bin/env bash
# Mutation unit: apply 2 mutants (sequential, clean restore between) to a script,
# run its test file per mutant. Usage:
#   mut-unit.sh <id> <script-rel> <test-rel> <m1name> <m1old> <m1new> <m2name> <m2old> <m2new>
set -u
ID="$1"; SCRIPT="$2"; TEST="$3"
M1N="$4"; M1O="$5"; M1W="$6"; M2N="$7"; M2O="$8"; M2W="$9"
BASE="$HOME/workspace/project-room"
WT="$HOME/workspace/.g6-wt/mut-$ID"
G="$HOME/workspace/pr-wave1000-guild-06"
RES="$G/findings/guild-06/logs/mut-$ID.result"
LOG="$G/findings/guild-06/logs/mut-$ID.log"
: > "$RES"; : > "$LOG"
git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1
git -C "$BASE" worktree add --detach "$WT" origin/main >>"$LOG" 2>&1 || { echo "unit=mut-$ID ERROR worktree-add-failed" >>"$RES"; exit 1; }
cd "$WT" || exit 1
run_one() {
  local name="$1" old="$2" new="$3" code
  git checkout -- "scripts/$SCRIPT" >>"$LOG" 2>&1
  if ! python3 - "$old" "$new" "scripts/$SCRIPT" >>"$LOG" 2>&1 <<'EOF'
import sys
old, new, path = sys.argv[1], sys.argv[2], sys.argv[3]
s = open(path).read()
c = s.count(old)
if c != 1:
    print(f"REPLACE-COUNT={c} for: {old[:80]!r}")
    sys.exit(2)
open(path, "w").write(s.replace(old, new))
EOF
  then echo "$name: NOT-APPLIED" >>"$RES"; return 0; fi
  if git diff --quiet -- "scripts/$SCRIPT"; then echo "$name: NOT-APPLIED(empty-diff)" >>"$RES"; return 0; fi
  mkdir -p .tmp
  timeout 600 env TMPDIR="$WT/.tmp" node --test "tests/$TEST" >"$LOG.$name.stdout" 2>&1
  code=$?
  if [ "$code" -eq 0 ]; then echo "$name: SURVIVED" >>"$RES"
  elif [ "$code" -eq 124 ]; then echo "$name: TIMEOUT(infra)" >>"$RES"
  else echo "$name: KILLED(exit=$code)" >>"$RES"; fi
}
{
  echo "unit=mut-$ID script=scripts/$SCRIPT test=tests/$TEST head=$(git rev-parse --short HEAD)"
  run_one "M1:$M1N" "$M1O" "$M1W"
  run_one "M2:$M2N" "$M2O" "$M2W"
} 2>>"$LOG"
cd "$BASE" && git worktree remove --force "$WT" >>"$LOG" 2>&1
echo "unit=mut-$ID DONE" >>"$RES"

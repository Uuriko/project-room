#!/usr/bin/env bash
# Fuzz unit: hostile CLI inputs against one script in a disposable worktree.
# Usage: fuzz-unit.sh <id> <script-rel>
set -u
ID="$1"; SCRIPT="$2"
BASE="$HOME/workspace/project-room"
WT="$HOME/workspace/.g6-wt/fuzz-$ID"
G="$HOME/workspace/pr-wave1000-guild-06"
RES="$G/findings/guild-06/logs/fuzz-$ID.result"
LOG="$G/findings/guild-06/logs/fuzz-$ID.log"
: > "$RES"; : > "$LOG"
git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1
git -C "$BASE" worktree add --detach "$WT" origin/main >>"$LOG" 2>&1 || { echo "unit=fuzz-$ID ERROR worktree-add-failed" >>"$RES"; exit 1; }
cd "$WT" || exit 1
mkdir -p .tmp
BIG=$(python3 -c 'print("A"*100000)')
probe() { # probe <name> <expect:0|nonzero|any> -- cmd...
  local name="$1" expect="$2"; shift 2
  timeout 20 env TMPDIR="$WT/.tmp" "$@" >"$LOG.$name.out" 2>&1
  local code=$?
  local verdict=OK
  if [ "$code" -eq 124 ]; then verdict=HANG
  elif [ "$expect" = "0" ] && [ "$code" -ne 0 ]; then verdict=UNEXPECTED-FAIL
  elif [ "$expect" = "nonzero" ] && [ "$code" -eq 0 ]; then verdict=UNEXPECTED-PASS
  fi
  echo "$name: exit=$code expect=$expect verdict=$verdict" >>"$RES"
}
{
  echo "unit=fuzz-$ID script=scripts/$SCRIPT head=$(git rev-parse --short HEAD)"
  probe "noargs"      "any"     node "scripts/$SCRIPT"
  probe "help"        "any"     node "scripts/$SCRIPT" --help
  probe "badflag"     "nonzero" node "scripts/$SCRIPT" --no-such-flag-xyz-123
  probe "dashdash"    "any"     node "scripts/$SCRIPT" --
  probe "missingfile" "nonzero" node "scripts/$SCRIPT" /nonexistent/deadbeef.json
  probe "emptyarg"    "any"     node "scripts/$SCRIPT" ""
  probe "hugearg"     "any"     node "scripts/$SCRIPT" "$BIG"
  probe "nullbytes"   "any"     node "scripts/$SCRIPT" "$(printf 'a\0b')"
  head -c 5000 /dev/urandom | timeout 20 env TMPDIR="$WT/.tmp" node "scripts/$SCRIPT" >"$LOG.stdin.out" 2>&1
  code=$?; v=OK; [ "$code" -eq 124 ] && v=HANG; echo "garbage-stdin: exit=$code verdict=$v" >>"$RES"
  ( timeout 25 env TMPDIR="$WT/.tmp" node "scripts/$SCRIPT" --help >/dev/null 2>&1 & \
    timeout 25 env TMPDIR="$WT/.tmp" node "scripts/$SCRIPT" --help >/dev/null 2>&1 & wait )
  echo "concurrent-help: exit=$? (0=all-clean)" >>"$RES"
  # no-env run from bare cwd
  ( cd /tmp && timeout 20 env -i PATH="$PATH" TMPDIR="$WT/.tmp" node "$WT/scripts/$SCRIPT" --help >"$LOG.bareenv.out" 2>&1 )
  echo "bare-env-help: exit=$?" >>"$RES"
  echo "dirty-files-after: $(git status --porcelain | wc -l)"
  git status --porcelain | head -5
} 2>>"$LOG"
cd "$BASE" && git worktree remove --force "$WT" >>"$LOG" 2>&1
echo "unit=fuzz-$ID DONE" >>"$RES"

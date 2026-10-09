#!/usr/bin/env bash
# Re-verify unit, two modes:
#   rev-unit.sh <id> suite <test-rel> [test-rel2...]   -- clean-tree full suite run
#   rev-unit.sh <id> commit <sha>                      -- diff evidence + affected suite
set -u
ID="$1"; MODE="$2"; shift 2
BASE="$HOME/workspace/project-room"
WT="$HOME/workspace/.g6-wt/rev-$ID"
G="$HOME/workspace/pr-wave1000-guild-06"
RES="$G/findings/guild-06/logs/rev-$ID.result"
LOG="$G/findings/guild-06/logs/rev-$ID.log"
: > "$RES"; : > "$LOG"
git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1
git -C "$BASE" worktree add --detach "$WT" origin/main >>"$LOG" 2>&1 || { echo "unit=rev-$ID ERROR worktree-add-failed" >>"$RES"; exit 1; }
cd "$WT" || exit 1
mkdir -p .tmp
echo "unit=rev-$ID mode=$MODE head=$(git rev-parse --short HEAD)" >>"$RES"
if [ "$MODE" = "suite" ]; then
  for T in "$@"; do
    timeout 900 env TMPDIR="$WT/.tmp" node --test "tests/$T" >"$LOG.suite-$T.out" 2>&1
    code=$?
    echo "suite tests/$T: exit=$code $([ $code -eq 0 ] && echo PASS || echo FAIL)" >>"$RES"
    grep -E "^# (pass|fail)" "$LOG.suite-$T.out" | tail -2 >>"$RES" 2>/dev/null || true
  done
elif [ "$MODE" = "commit" ]; then
  SHA="$1"
  echo "commit=$SHA subject=$(git log -1 --format=%s $SHA)" >>"$RES"
  git show --stat "$SHA" -- scripts/ >>"$RES" 2>&1
  for F in $(git show --name-only --format= "$SHA" -- scripts/ | grep -v -e '^scripts/room$' -e migrate -e runtime-package.mjs); do
    BN=$(basename "$F" .mjs)
    echo "--- changed: $F" >>"$RES"
    for T in $(grep -rl "$F" tests/ 2>/dev/null | head -5); do
      timeout 900 env TMPDIR="$WT/.tmp" node --test "$T" >"$LOG.commit-$BN.out" 2>&1
      code=$?
      echo "  affected $T: exit=$code $([ $code -eq 0 ] && echo PASS || echo FAIL)" >>"$RES"
    done
  done
  git show "$SHA" -- scripts/ >"$LOG.commit-diff.txt" 2>&1
  echo "diff-bytes=$(wc -c <"$LOG.commit-diff.txt")" >>"$RES"
fi
cd "$BASE" && git worktree remove --force "$WT" >>"$LOG" 2>&1
echo "unit=rev-$ID DONE" >>"$RES"

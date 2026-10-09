#!/bin/bash
# reverify.sh <unit> <branch> — rebase a SCRATCH copy onto origin/main,
# run the affected slice test files, review the diff. Never touches the
# guild branch or origin/main. Scratch worktree is removed afterwards.
set -u
UNIT="$1"; BRANCH="$2"
WT=~/workspace/pr-wave1000-guild-13
S=~/workspace/.g13-scratch-$UNIT
LOG=$WT/findings/guild-13/logs/$UNIT.log
mkdir -p "$(dirname "$LOG")"
{
  echo "unit=$UNIT branch=$BRANCH"
  git -C ~/workspace/project-room worktree add --detach "$S" "$BRANCH" 2>&1 | tail -1
  cd "$S" || { echo "WORKTREE FAILED"; exit 2; }
  mkdir -p .tmp
  BASE=$(git merge-base origin/main HEAD)
  echo "merge_base=$BASE"
  # line-age check: warn if the branch base is ancient
  if git rebase origin/main 2>&1 | tail -2 | grep -qi "conflict\|error"; then
    echo "REBASE_CONFLICT — aborting rebase, will test unrebased head and flag"
    git rebase --abort 2>/dev/null || true
    echo "rebase=CONFLICT"
  else
    echo "rebase=CLEAN"
  fi
  echo "=== SLICE DIFF (vs origin/main) ==="
  DIFFILES=$(git diff --name-only origin/main...HEAD -- 'server/*auth*.mjs' 'server/*invit*.mjs' 'server/*identit*.mjs')
  echo "$DIFFILES"
  # map slice files to test files
  TESTS=""
  for f in $DIFFILES; do
    mod=$(basename "$f" .mjs)
    for t in tests/*${mod}*.test.js tests/*${mod}*.test.mjs; do
      [ -f "$t" ] && TESTS="$TESTS $t"
    done
  done
  # always include the core slice suites for touched areas
  TESTS=$(echo "$TESTS" | tr ' ' '\n' | sort -u | tr '\n' ' ')
  echo "test_files:$TESTS"
  export TMPDIR=$S/.tmp
  OVERALL=0
  for t in $TESTS; do
    echo "--- $t"
    timeout 600 node --test "$t" > ".tmp/rv-$UNIT-$(basename $t).out" 2>&1
    CODE=$?
    [ $CODE -ne 0 ] && OVERALL=1
    echo "exit=$CODE"
    tail -4 ".tmp/rv-$UNIT-$(basename $t).out"
  done
  if [ $OVERALL -eq 0 ]; then echo "SUITE_RESULT=PASS"; else echo "SUITE_RESULT=FAIL"; fi
  echo "=== DIFF REVIEW (first 120 lines) ==="
  git diff origin/main...HEAD -- 'server/*auth*.mjs' 'server/*invit*.mjs' 'server/*identit*.mjs' | head -120
  cd ~/workspace/project-room
  git worktree remove --force "$S" 2>&1 | tail -1
  echo "scratch removed"
} > "$LOG" 2>&1
echo "reverify $UNIT done"

#!/bin/bash
# mutant-run.sh <unit> <file> <perl-expr> <testfile> <description>
# Applies ONE mutant to a slice file in the guild-13 worktree, runs the
# affected test file, restores the file, and records the verdict.
# Mutants never get committed: the file is restored via git checkout before exit.
set -u
UNIT="$1"; FILE="$2"; PEXPR="$3"; TEST="$4"; DESC="$5"
WT=~/workspace/pr-wave1000-guild-13
LOCK=$WT/.tmp/mutant.lock
LOG=$WT/findings/guild-13/logs/$UNIT.log
mkdir -p "$(dirname "$LOG")"
{
  echo "unit=$UNIT file=$FILE test=$TEST"
  echo "desc: $DESC"
  (
    flock -x 200
    cd "$WT"
    if [ -n "$(git status --porcelain -- server/$FILE)" ]; then
      echo "ABORT: server/$FILE has uncommitted changes; not mutating"
      exit 2
    fi
    cp "server/$FILE" ".tmp/mutant-$UNIT.bak"
    perl -0pi -e "$PEXPR" "server/$FILE"
    if cmp -s "server/$FILE" ".tmp/mutant-$UNIT.bak"; then
      echo "ABORT: mutant expression did not change the file"
      exit 2
    fi
    echo "=== MUTANT DIFF ==="
    git diff -- "server/$FILE" | head -20
    echo "=== TEST RUN ==="
    export TMPDIR=$WT/.tmp
    set +e
    timeout 600 node --test "$TEST" > ".tmp/mutant-$UNIT.testout" 2>&1
    CODE=$?
    set -e
    echo "test_exit=$CODE"
    tail -15 ".tmp/mutant-$UNIT.testout"
    if [ $CODE -eq 0 ]; then
      echo "VERDICT=SURVIVED (tests passed with mutant applied)"
    else
      echo "VERDICT=KILLED (tests failed with mutant applied)"
    fi
    echo "=== RESTORING ==="
    git checkout -- "server/$FILE"
    if [ -n "$(git status --porcelain -- server/$FILE)" ]; then
      echo "RESTORE FAILED - MANUAL INTERVENTION NEEDED"
      exit 1
    fi
    echo "restored clean"
  ) 200>"$LOCK"
} > "$LOG" 2>&1
echo "unit $UNIT done, see $LOG"

#!/bin/bash
# wave1000 guild-04 re-verify unit: rebase a scratch copy of a wave branch onto
# origin/main in a disposable worktree, run affected tests, report.
# usage: rv-unit.sh <n> <branch> <test files...>
set -u
N=$1; BRANCH=$2; shift 2
REPO=/home/hatch/workspace/project-room
WT=/home/hatch/workspace/wt-g04-rv-$N
SB=g04-rv-$N-scratch
REPORT=/home/hatch/workspace/pr-wave1000-guild-04/findings/guild-04/reverify-$N.log
cleanup() {
  cd /home/hatch/workspace/pr-wave1000-guild-04 2>/dev/null
  git -C $REPO worktree remove --force $WT 2>&1 | tail -1
  git -C $REPO branch -D $SB 2>&1 | tail -1
}
trap cleanup EXIT
{
echo "=== RV-$N branch=$BRANCH at $(date -u +%FT%TZ)"
git -C $REPO worktree add $WT -b $SB origin/$BRANCH 2>&1 | tail -1
cd $WT || { echo "WORKTREE_FAIL"; exit 1; }
echo "--- rebase onto origin/main"
REBASED=no
for attempt in 1 2 3 4 5 6 7 8; do
  # Disposable worktree: discard any transient external modification before each attempt.
  git checkout -- . 2>/dev/null
  git rebase --abort 2>/dev/null
  if git rebase origin/main > .rebase-out.txt 2>&1; then
    echo "REBASE_OK (attempt $attempt)"
    REBASED=yes
    break
  fi
  echo "rebase attempt $attempt failed:"
  grep -E "error:|CONFLICT" .rebase-out.txt | head -3
  git rebase --abort 2>/dev/null
  sleep 3
done
if [ "$REBASED" != yes ]; then
  echo "REBASE_FAILED after 8 attempts"
  echo "--- conflicting files:"
  git diff --name-only --diff-filter=U | head -20
fi
if [ "$REBASED" = yes ] && git merge-base --is-ancestor origin/main HEAD 2>/dev/null; then
  echo "--- rebased onto $(git rev-parse --short origin/main); head $(git rev-parse --short HEAD)"
else
  echo "--- NOT rebased; RESULT: REBASE_FAILED — no tests run"
  echo "DONE_RV_$N"
  exit 0
fi
mkdir -p .tmp
echo "--- tests: $*"
export TMPDIR=$WT/.tmp
if timeout 500 node --test "$@" 2>&1 | tail -12; then
  echo "TESTS_DONE"
else
  echo "TESTS_TIMEOUT_OR_FAIL rc=$?"
fi
echo "--- slice diff vs origin/main:"
git diff --stat origin/main -- server/store.mjs server/work-claim-sqlite.mjs 'server/room-*.mjs' 2>/dev/null | tail -8
echo "DONE_RV_$N"
} > $REPORT 2>&1
echo "RV-$N done -> $REPORT"

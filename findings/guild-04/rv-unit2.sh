#!/bin/bash
# wave1000 guild-04 re-verify unit v2: quiescence-aware rebase.
# An external process transiently modifies fresh worktrees (~60s cycle); we wait
# for quiescence before each rebase attempt instead of racing it.
# usage: rv-unit2.sh <n> <branch> <test files...>
set -u
N=$1; BRANCH=$2; shift 2
REPO=/home/hatch/workspace/project-room
WT=/home/hatch/workspace/wt-g04-rv-$N
SB=g04-rv-$N-scratch
REPORT=/home/hatch/workspace/pr-wave1000-guild-04/findings/guild-04/reverify-$N.log
cleanup() {
  cd /home/hatch/workspace/pr-wave1000-guild-04 2>/dev/null
  git -C $REPO worktree remove --force $WT >/dev/null 2>&1
  git -C $REPO branch -D $SB >/dev/null 2>&1
}
trap cleanup EXIT
{
echo "=== RV-$N branch=$BRANCH at $(date -u +%FT%TZ) (v2 quiescence)"
git -C $REPO worktree remove --force $WT >/dev/null 2>&1
git -C $REPO branch -D $SB >/dev/null 2>&1
for wa in 1 2 3 4 5; do
  if git -C $REPO worktree add $WT -b $SB origin/$BRANCH >/dev/null 2>&1; then
    echo "WORKTREE_OK (attempt $wa)"; break
  fi
  echo "worktree add attempt $wa failed; retrying"
  git -C $REPO worktree remove --force $WT >/dev/null 2>&1
  git -C $REPO branch -D $SB >/dev/null 2>&1
  sleep 20
done
cd $WT || { echo "WORKTREE_FAIL"; exit 1; }
quiesce() {
  # The external process modifies then reverts files on a ~60s cycle. A dirty
  # tree resolves itself; never `git checkout -- .` here (it refreshes mtimes
  # and defeats the quiet-window check). Rebase immediately once clean.
  for q in $(seq 1 60); do
    if [ -z "$(git status --porcelain)" ]; then echo "QUIESCENT after $((q*10))s"; return 0; fi
    sleep 10
  done
  echo "QUIESCE_TIMEOUT (proceeding anyway)"
  return 0
}
echo "--- rebase onto origin/main"
REBASED=no
for attempt in 1 2 3 4 5; do
  quiesce || true
  git rebase --abort >/dev/null 2>&1
  if git rebase origin/main > .rebase-out.txt 2>&1; then
    echo "REBASE_OK (attempt $attempt)"
    REBASED=yes
    break
  fi
  echo "rebase attempt $attempt failed:"
  grep -E "error:|CONFLICT" .rebase-out.txt | head -3
  git rebase --abort >/dev/null 2>&1
  sleep 10
done
if [ "$REBASED" != yes ]; then
  echo "--- NOT rebased; RESULT: REBASE_FAILED — no tests run"
  echo "DONE_RV_$N"
  exit 0
fi
echo "--- rebased onto $(git rev-parse --short origin/main); head $(git rev-parse --short HEAD)"
mkdir -p .tmp
echo "--- tests: $*"
export TMPDIR=$WT/.tmp
if timeout 500 node --test "$@" > .test-out.txt 2>&1; then
  echo "TESTS_EXIT_0"
else
  echo "TESTS rc=$?"
fi
grep -aE "ℹ (pass|fail) [0-9]+" .test-out.txt | tail -4
grep -aE "^not ok" .test-out.txt | head -10
echo "--- slice diff vs origin/main:"
git diff --stat origin/main -- server/store.mjs server/work-claim-sqlite.mjs 'server/room-*.mjs' 2>/dev/null | tail -8
echo "DONE_RV_$N"
} > $REPORT 2>&1

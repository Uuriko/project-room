#!/usr/bin/env bash
# Guild-03 re-verify unit: rebase a scratch copy of a wave branch onto
# origin/main in a disposable worktree, run the affected suite, save the diff.
# usage: reverify-unit.sh <R#> <branch> <testfiles...>
set -u
R="$1"; BRANCH="$2"; shift 2
REPO=~/workspace/project-room
WT=~/workspace/pr-wave1000-guild-03/.tmp/rv-$R
OUT=~/workspace/pr-wave1000-guild-03/findings/guild-03/reverify-$R.md
SLICE="server/agent-plugin-routes.mjs server/bounty-escrow-routes.mjs server/feedback-routes.mjs server/inbox-collab-routes.mjs server/legal-routes.mjs server/matchmaking-routes.mjs server/mcp-arg-errors.mjs server/mcp-discovery.mjs server/mcp-full-profile.mjs server/mcp-hosted-tools.mjs server/mcp-http.mjs server/mcp-identity-mint.mjs server/mcp-public-work.mjs server/mcp-room-profile.mjs server/next-actions-routes.mjs server/operator-routes.mjs server/supervision-routes.mjs server/work-claim-routes.mjs server/routes/"
{
echo "# re-verify $R: $BRANCH"
echo "started: $(date -u +%FT%TZ)"
git -C "$REPO" worktree add "$WT" "origin/$BRANCH" 2>&1 | tail -1
cd "$WT" || { echo "WORKTREE-FAILED"; exit 1; }
BASE_BEFORE=$(git rev-parse --short HEAD)
MERGE_BASE=$(git merge-base origin/main HEAD | cut -c1-8)
echo "branch head: $BASE_BEFORE, merge-base with origin/main: $MERGE_BASE"
# slice diff BEFORE rebase (for adversarial review even if rebase conflicts)
git diff "origin/main...HEAD" -- $SLICE > "$WT.slice-diff.txt" 2>/dev/null
echo "slice files changed: $(git diff --name-only "origin/main...HEAD" -- $SLICE | tr '\n' ' ')"
# scratch rebase
git checkout -qb "rv-scratch-$R" 2>/dev/null
if git rebase origin/main >/tmp/rb-$R.log 2>&1; then
  echo "rebase: CLEAN onto $(git rev-parse --short origin/main)"
  REBASED=yes
else
  echo "rebase: CONFLICT — aborted, testing un-rebased head"
  git rebase --abort >/dev/null 2>&1
  REBASED=no
fi
echo "running affected suite: $*"
export TMPDIR="$WT/.tmp"; mkdir -p "$TMPDIR"
PASS=0; FAIL=0; FAILED_FILES=""
for t in "$@"; do
  if timeout 570 node --test "$t" >/tmp/test-$R.log 2>&1; then PASS=$((PASS+1)); else FAIL=$((FAIL+1)); FAILED_FILES="$FAILED_FILES $t"; fi
done
echo "suite: $PASS passed, $FAIL failed$FAILED_FILES"
echo "node --check on slice files:"
for f in $(git diff --name-only "origin/main...HEAD" -- $SLICE); do node --check "$f" >/dev/null 2>&1 || echo "  SYNTAX-FAIL: $f"; done
echo "done: $(date -u +%FT%TZ)"
} > "$OUT" 2>&1
cp "$WT.slice-diff.txt" ~/workspace/pr-wave1000-guild-03/findings/guild-03/reverify-$R.diff 2>/dev/null
git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
git -C "$REPO" branch -D "rv-scratch-$R" 2>/dev/null
echo "unit $R finished -> $OUT"

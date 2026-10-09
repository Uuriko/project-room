#!/bin/bash
# rev-run.sh <slug> <branch> — one re-verify unit: scratch worktree, rebase onto
# origin/main, run affected suite, adversarial diff review, record, clean up.
set -u
SLUG="$1"; BRANCH="$2"
BASE="$HOME/workspace/pr-wave1000-guild-01"
WT="$HOME/workspace/pr-g01-rev-$SLUG"
OUT="$BASE/findings/guild-01/reverify-raw/$SLUG.md"
mkdir -p "$BASE/findings/guild-01/reverify-raw" "$BASE/.tmp"

cleanup() { git -C "$BASE" worktree remove --force "$WT" >/dev/null 2>&1 || true; git -C "$BASE" branch -D "g01rev-$SLUG" >/dev/null 2>&1 || true; }
trap cleanup EXIT

{
echo "# re-verify $BRANCH"
git -C "$BASE" worktree add -f "$WT" -b "g01rev-$SLUG" "$BRANCH" >/dev/null 2>&1
cd "$WT"
MB=$(git merge-base origin/main "$BRANCH")
echo "- merge-base with origin/main: $MB"
echo "- origin/main: $(git rev-parse --short origin/main)"
git fetch origin -q "$BRANCH" 2>/dev/null || true

echo "## rebase"
if git rebase origin/main >/tmp/g01-rev-$SLUG-rebase.log 2>&1; then
  echo "- rebase onto origin/main: CLEAN"
  REBASED=1
else
  git rebase --abort >/dev/null 2>&1 || true
  CONFLICTS=$(grep -E "^CONFLICT" /tmp/g01-rev-$SLUG-rebase.log | head -5)
  echo "- rebase onto origin/main: CONFLICT"
  echo "$CONFLICTS" | sed 's/^/  /'
  if git merge --no-edit origin/main >/tmp/g01-rev-$SLUG-merge.log 2>&1; then
    echo "- fallback merge origin/main: CLEAN (tests run on merged tree)"
    REBASED=1
  else
    git merge --abort >/dev/null 2>&1 || true
    echo "- fallback merge origin/main: CONFLICT — BREAKAGE: branch cannot be integrated without manual resolution"
    REBASED=0
  fi
fi

echo "## slice files changed (origin/main...HEAD)"
git diff --name-only origin/main...HEAD -- server/ | grep -E 'work-claim|claim-coordination' | sed 's/^/- /'

echo "## diff stat (whole branch)"
git diff --stat origin/main...HEAD | tail -5

echo "## adversarial review"
DIFF=$(git diff origin/main...HEAD -- server/work-claims.mjs server/work-claim-*.mjs server/claim-coordination.mjs)
REMOVED_CHECKS=$(echo "$DIFF" | grep -cE "^-.*\b(check|assert|fail)\(" || true)
ADDED_UNCHECKED=$(echo "$DIFF" | grep -cE "^\+" || true)
BOUNDARY=$(echo "$DIFF" | grep -E "^[-+].*(<=|>=|===|!==|<|>)" | grep -cE "^[-]" || true)
echo "- removed check/assert/fail lines: $REMOVED_CHECKS"
echo "- added lines in slice: $ADDED_UNCHECKED"
echo "- removed comparison lines (boundary churn): $BOUNDARY"
echo "$DIFF" | grep -E "^[-].*\b(check|assert|fail)\(" | head -10 | sed 's/^/  REMOVED: /'
echo "$DIFF" | grep -E "^\+" | grep -iE "todo|fixme|hack|xxx|skip" | head -5 | sed 's/^/  SMELL: /'

echo "## affected tests"
declare -A MAP
MAP["server/work-claim-routes.mjs"]="tests/work-claim-board.test.js tests/work-claim-durable-http.test.js tests/work-claim-client.test.js"
MAP["server/work-claims.mjs"]="tests/work-claims.test.js tests/work-claim-leases.test.js tests/work-claim-guards.test.js tests/claims-state-machine.property.test.js"
MAP["server/work-claim-sqlite.mjs"]="tests/work-claim-durable-http.test.js tests/work-claim-retention.test.js"
MAP["server/work-claim-events.mjs"]="tests/work-claim-events.test.js"
MAP["server/work-claim-mirror.mjs"]="tests/work-claim-board.test.js"
MAP["server/claim-coordination.mjs"]="tests/claim-settle-1526.test.js tests/work-claim-settle-retry.test.js tests/work-claim-batch-outcome.test.js"
CHANGED=$(git diff --name-only origin/main...HEAD -- server/ | grep -E 'work-claim|claim-coordination')
TESTS=""
for f in $CHANGED; do TESTS="$TESTS ${MAP[$f]:-}"; done
TESTS=$(echo "$TESTS" | tr ' ' '\n' | sort -u | grep . || true)
echo "$TESTS" | sed 's/^/- /'
mkdir -p "$WT/.tmp"
if [ "$REBASED" = "1" ]; then
  for t in $TESTS; do
    if [ ! -f "$WT/$t" ]; then echo "- MISSING: $t"; continue; fi
    if TMPDIR="$WT/.tmp" timeout 300 node --test "$WT/$t" >"$WT/.tmp/tap.log" 2>&1; then
      echo "- PASS: $t"
    else
      echo "- FAIL: $t"
      grep -E "^(not ok|# fail)" "$WT/.tmp/tap.log" | head -5 | sed 's/^/    /'
    fi
  done
else
  echo "- SKIPPED (branch does not integrate)"
fi
echo "## verdict: recorded above"
} >"$OUT" 2>&1
grep -E "^(#|-|  (REMOVED|SMELL))" "$OUT" | head -40

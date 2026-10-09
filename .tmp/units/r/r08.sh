#!/bin/bash
# r08: scratch rebase check — does the telemetry slice apply onto current
# origin/main? Uses a DETACHED scratch worktree (no branch). Reports
# apply-check results per file group, then runs the affected suite on the
# applied slice. Cleans up the scratch worktree at the end.
set -u
W=~/workspace/pr-wave1000-guild-11
export TMPDIR=$W/.tmp
SCR=$W/.tmp/scratch-rebase
PATCH=$W/.tmp/slice.patch
LOG=$W/.tmp/units/r08.rebaselog

git -C "$W" worktree remove --force "$SCR" >/dev/null 2>&1
git -C "$W" worktree add --detach "$SCR" origin/main >/dev/null 2>&1 || { echo "R08 FAIL: scratch worktree"; exit 1; }
cleanup() { git -C "$W" worktree remove --force "$SCR" >/dev/null 2>&1; }
trap cleanup EXIT

MB=$(git -C "$W" merge-base wave300/telemetry-prod origin/main)
echo "merge-base: $(git -C "$W" rev-parse --short "$MB") ($(git -C "$W" log -1 --format=%ad --date=short "$MB"))"
echo "origin/main: $(git -C "$W" rev-parse --short origin/main)"

SLICE_FILES="telemetry/gauges.mjs telemetry/validate.mjs telemetry/verify.mjs telemetry/collect.mjs telemetry/submit.mjs telemetry/build-dashboard-data.mjs telemetry/capture-baseline.mjs telemetry/finding-schema.json telemetry/tripwire-contract.test.mjs server/tripwires.mjs tests/tripwires.test.mjs"
# shellcheck disable=SC2086
git -C "$W" diff "$MB" wave300/telemetry-prod -- $SLICE_FILES > "$PATCH"
echo "slice patch: $(wc -l < "$PATCH") lines, $(grep -c '^diff --git' "$PATCH") files"

cd "$SCR" || exit 1
if git apply --check --verbose "$PATCH" >"$LOG" 2>&1; then
  echo "apply --check: CLEAN"
else
  echo "apply --check: CONFLICTS"
  cat "$LOG"
  echo "R08 RESULT: slice does NOT apply cleanly onto origin/main (see above)"
  exit 1
fi

git apply "$PATCH" || { echo "R08 FAIL: apply failed after clean check"; exit 1; }
echo "--- affected suite on applied slice ---"
TMPDIR=$W/.tmp timeout 180 node --test tests/tripwires.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)' || true
TMPDIR=$W/.tmp timeout 60 node --test telemetry/tripwire-contract.test.mjs 2>&1 | grep -E '^ℹ (tests|pass|fail)' || true
echo "R08 PASS: slice applies cleanly and affected suites run"

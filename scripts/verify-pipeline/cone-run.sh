#!/usr/bin/env bash
# cone-run.sh — run an affected-test cone and emit a JSON verdict (W2)
# Usage: cone-run.sh <worktree-dir> <testlist-file> [label]
# stdout: one JSON object.
# Per-file logs: <worktree>/.cone-run-<label>/<sanitized-test-name>.log
# (one node --test process per file, run with xargs -P $CONE_JOBS so a
# failure is always attributable to its file — required for flaky retry
# and base-vs-head failure comparison).
set -euo pipefail
WT="${1:?usage: cone-run.sh <worktree> <testlist> [label]}"
LIST="${2:?usage: cone-run.sh <worktree> <testlist> [label]}"
LABEL="${3:-cone}"
JOBS="${CONE_JOBS:-$(nproc 2>/dev/null || echo 2)}"
FILE_TIMEOUT="${CONE_FILE_TIMEOUT:-600}"

cd "$WT"
mkdir -p .tmp
mapfile -t FILES < <(grep -v '^\s*$' "$LIST" || true)
LOGDIR=".cone-run-${LABEL}"
rm -rf "$LOGDIR"; mkdir -p "$LOGDIR"

if [ "${#FILES[@]}" -eq 0 ]; then
  printf '{"label":"%s","files":0,"duration_s":0,"pass":0,"fail":0,"exit":0,"verdict":"empty-cone"}\n' "$LABEL"
  exit 0
fi

START=$(date +%s.%N)
# one process per file; -P parallel, -0 safe names
printf '%s\0' "${FILES[@]}" | xargs -0 -P "$JOBS" -I{} bash -c '
  f="$1"; wt="$2"; label="$3"; to="$4"
  safe="$(echo "$f" | tr "/" "_" )"
  TMPDIR="$wt/.tmp" timeout "$to" node --test "$f" > "$wt/.cone-run-$label/$safe.log" 2>&1
  echo "$? $f" >> "$wt/.cone-run-$label/exit-codes.txt"
' _ {} "$PWD" "$LABEL" "$FILE_TIMEOUT"
END=$(date +%s.%N)
DUR=$(awk -v s="$START" -v e="$END" 'BEGIN{printf "%.2f", e-s}')

PASS=0; FAIL=0; TIMEOUT=0; FILEFAIL=0
for f in "${FILES[@]}"; do
  safe="$(echo "$f" | tr '/' '_')"
  lg="$LOGDIR/$safe.log"
  p="$(grep -E '^ℹ pass [0-9]+$' "$lg" 2>/dev/null | tail -1 | awk '{print $3}')"; p="${p:-0}"
  fl="$(grep -E '^ℹ fail [0-9]+$' "$lg" 2>/dev/null | tail -1 | awk '{print $3}')"; fl="${fl:-0}"
  PASS=$((PASS + p)); FAIL=$((FAIL + fl))
  ec="$(awk -v f="$f" '$2==f{print $1}' "$LOGDIR/exit-codes.txt" 2>/dev/null | tail -1)"
  if [ "$ec" = "124" ]; then TIMEOUT=$((TIMEOUT+1)); fi
  if [ "$fl" -gt 0 ] || { [ -n "$ec" ] && [ "$ec" -ne 0 ]; }; then FILEFAIL=$((FILEFAIL+1)); fi
done

if [ "$TIMEOUT" -gt 0 ]; then VERDICT="timeout"; EXIT=124
elif [ "$FAIL" -gt 0 ] || [ "$FILEFAIL" -gt 0 ]; then VERDICT="fail"; EXIT=1
else VERDICT="pass"; EXIT=0; fi

printf '{"label":"%s","files":%d,"duration_s":%s,"pass":%d,"fail":%d,"exit":%d,"verdict":"%s"}\n' \
  "$LABEL" "${#FILES[@]}" "$DUR" "$PASS" "$FAIL" "$EXIT" "$VERDICT"

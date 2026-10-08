#!/usr/bin/env bash
# verify-pipeline.sh — scratch-trunk verification pipeline (W2, integration guild)
#
# Verifies candidate fixes in isolated scratch worktrees BEFORE they land.
# Semantic collisions (two fixes, same behavior) are resolved by running both
# in scratch; winner = green + smaller diff.
#
# Subcommands:
#   verify  <base> <head> <candidate-id>   verify one candidate end-to-end
#   collide <base> <refA> <refB>            resolve a semantic collision
#   cone    <worktree> <base> <head>        print affected-test cone (debug aid)
#
# Layout: runs from its own directory; uses cone.sh and cone-run.sh alongside.
# Scratch worktrees live under $VERIFY_SCRATCH (default: ./scratch).
# NEVER commits to, pushes, or checks out branches in the source repo — all
# work happens in --detached worktrees. Never touches main.
#
# Exit codes: 0 verdict green/no-collision-resolved, 1 verdict red,
# 2 infra failure (retry the pipeline), 3 usage error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="${VERIFY_SCRATCH:-$HERE/scratch}"
mkdir -p "$SCRATCH"

# ---- timeouts (seconds) ----
T_INGEST=60        # resolve refs, compute diffstat
T_WORKTREE=300     # git worktree add
T_CONE=180         # cone.sh mapping
T_CONE_RUN=1200    # node --test on the cone
T_TOTAL=1800       # per-candidate wall budget
FLAKY_RETRIES=2    # reruns of failed test files before calling it red

log()  { echo "[verify] $*" >&2; }
die()  { echo "[verify] FATAL: $*" >&2; exit "${2:-2}"; }

# ---- stage 1: ingest -------------------------------------------------------
# resolve <ref> to a commit; emit "id base head changed_files add del"
ingest() {
  local base="$1" head="$2" cid="$3"
  log "ingest: $cid base=$base head=$head"
  local b h
  b="$(timeout "$T_INGEST" git -C "$REPO" rev-parse --verify "$base^{commit}" 2>/dev/null)" \
    || die "ingest: cannot resolve base $base" 2
  h="$(timeout "$T_INGEST" git -C "$REPO" rev-parse --verify "$head^{commit}" 2>/dev/null)" \
    || die "ingest: cannot resolve head $head" 2
  if [ "$b" = "$h" ]; then die "ingest: empty change ($cid)" 1; fi
  local stat
  stat="$(git -C "$REPO" diff --shortstat "$b" "$h" -- . | tr -d ' ')" || stat=""
  local files add del
  files="$(git -C "$REPO" diff --name-only "$b" "$h" -- . | wc -l)"
  add="$(echo "$stat" | grep -oE '[0-9]+insertions' | grep -oE '[0-9]+')"; add="${add:-0}"
  del="$(echo "$stat" | grep -oE '[0-9]+deletions'  | grep -oE '[0-9]+')";  del="${del:-0}"
  echo "$cid $b $h $files $add $del"
}

# ---- stage 2: scratch worktree ----------------------------------------------
build_worktree() {
  local cid="$1" head="$2"
  local wt="$SCRATCH/$cid"
  if [ -d "$wt" ]; then
    log "worktree $cid exists; reusing"
  else
    log "worktree: $cid @ ${head:0:12}"
    timeout "$T_WORKTREE" git -C "$REPO" worktree add --detach "$wt" "$head" \
      >/dev/null 2>&1 || die "worktree add failed for $cid" 2
    # Fast, hermetic-enough deps: symlink the source repo's node_modules.
    # (Documented caveat: if the candidate changes package.json deps, set
    # VERIFY_NPM_CI=1 to run npm ci instead — slower but exact.)
    if [ "${VERIFY_NPM_CI:-0}" = "1" ]; then
      ( cd "$wt" && npm ci --no-audit --no-fund ) || die "npm ci failed for $cid" 2
    else
      ln -sfn "$REPO/node_modules" "$wt/node_modules"
    fi
    mkdir -p "$wt/.tmp"
  fi
  echo "$wt"
}

# ---- stage 3+4: cone + run (with flaky retry) --------------------------------
run_cone() {
  local wt="$1" base="$2" head="$3" cid="$4"
  local conefile="$SCRATCH/$cid.cone.txt"
  log "cone: mapping affected tests for $cid"
  timeout "$T_CONE" "$HERE/cone.sh" "$wt" "$base" "$head" 2>"$SCRATCH/$cid.gaps.txt" \
    > "$conefile" || die "cone mapping failed for $cid" 2
  local n; n="$(grep -c . "$conefile" || true)"
  if [ "$n" -eq 0 ]; then
    # Fail closed: no affected tests found. Green-by-default on an empty cone
    # is how regressions slip through; route to triage instead.
    log "cone: EMPTY for $cid — fail closed (verdict no-coverage)"
    printf '{"candidate":"%s","verdict":"no-coverage","files":0,"reason":"empty affected-test cone"}\n' "$cid"
    return 1
  fi
  log "cone: $n test files for $cid"
  local verdict
  verdict="$(timeout "$T_CONE_RUN" "$HERE/cone-run.sh" "$wt" "$conefile" "$cid")"
  local v; v="$(echo "$verdict" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
  if [ "$v" = "fail" ] && [ "${VERIFY_BASELINE:-1}" = "1" ]; then
    # Baseline comparison: failures already present at base are pre-existing
    # and do not block the candidate. Only NEW failures are red.
    verdict="$(baseline_compare "$wt" "$base" "$cid" "$verdict")"
    v="$(echo "$verdict" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
  fi
  if [ "$v" = "fail" ] && [ "$FLAKY_RETRIES" -gt 0 ]; then
    verdict="$(flaky_retry "$wt" "$conefile" "$cid" "$verdict")"
  fi
  echo "$verdict" | sed "s/\"label\":\"$cid\"/\"candidate\":\"$cid\"/"
}

# Rerun the failed test files against the BASE commit. If the failing test
# names are identical at base, the failures are pre-existing:
# verdict -> "pass-with-baseline-failures" (landable, failures listed).
# Otherwise the candidate introduced new failures -> stays red.
# List cone files that failed: per-file logs under .cone-run-<label>/ containing ✖.
failed_files() {
  local wt="$1" label="$2" out="$3"
  : > "$out"
  for lg in "$wt/.cone-run-$label"/tests_*.log; do
    [ -f "$lg" ] || continue
    if grep -qE '^✖' "$lg"; then
      basename "$lg" .log | tr '_' '/'
    fi
  done | sort -u > "$out" || true
}

# Failing test NAMES within a per-file log (strip the duration suffix).
failed_names() {
  local lg="$1"
  grep -E '^✖ ' "$lg" 2>/dev/null | sed -E 's/^✖ //; s/ \([0-9.]+ms\)$//' | sort -u || true
}

baseline_compare() {
  local wt="$1" base="$2" cid="$3" cur="$4"
  local failed="$SCRATCH/$cid.failed.txt"
  failed_files "$wt" "$cid" "$failed"
  if [ ! -s "$failed" ]; then
    log "baseline: could not isolate failed files; keeping red"
    echo "$cur"; return 0
  fi
  local bwt; bwt="$(build_worktree "$cid-base" "$base")"
  timeout "$T_CONE_RUN" "$HERE/cone-run.sh" "$bwt" "$failed" "$cid-base" >/dev/null 2>&1 || true
  local hf bf hbf bbf
  hf=""; bf=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    safe="$(echo "$f" | tr '/' '_')"
    hbf="$(failed_names "$wt/.cone-run-$cid/$safe.log")"
    bbf="$(failed_names "$bwt/.cone-run-$cid-base/$safe.log")"
    hf="$hf
$hbf"; bf="$bf
$bbf"
  done < "$failed"
  hf="$(echo "$hf" | sed '/^$/d' | sort -u)"; bf="$(echo "$bf" | sed '/^$/d' | sort -u)"
  if [ -n "$hf" ] && [ "$hf" = "$bf" ]; then
    log "baseline: identical failures at base — pre-existing, not caused by $cid"
    echo "$cur" | sed 's/"verdict":"fail"/"verdict":"pass-with-baseline-failures"/'
  else
    log "baseline: NEW failures introduced by $cid (keeping red)"
    echo "$cur"
  fi
}

# Rerun only the failed test files up to FLAKY_RETRIES times.
# A test that fails then passes on retry is quarantined as flaky, not red:
# verdict becomes "pass-with-flakes" (still landable, flagged for quarantine).
flaky_retry() {
  local wt="$1" conefile="$2" cid="$3" cur="$4"
  local attempt=1 v
  v="$(echo "$cur" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
  while [ "$v" = "fail" ] && [ "$attempt" -le "$FLAKY_RETRIES" ]; do
    log "flaky-check: $cid attempt $attempt/$FLAKY_RETRIES — rerunning failed files"
    local failed="$SCRATCH/$cid.failed.txt"
    failed_files "$wt" "$cid" "$failed"
    if [ ! -s "$failed" ]; then
      log "flaky-check: could not isolate failed files; keeping red"
      break
    fi
    local retry
    retry="$(timeout "$T_CONE_RUN" "$HERE/cone-run.sh" "$wt" "$failed" "$cid-retry$attempt")"
    local rv; rv="$(echo "$retry" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
    if [ "$rv" = "pass" ]; then
      log "flaky-check: $cid failures did NOT reproduce on retry — marking flaky"
      echo "$cur" | sed 's/"verdict":"fail"/"verdict":"pass-with-flakes"/'
      return 0
    fi
    log "flaky-check: $cid failures reproduced (attempt $attempt) — still red"
    attempt=$((attempt+1))
  done
  echo "$cur"
}

# ---- stage 5: collision detector ----------------------------------------------
# Two candidates collide semantically when their affected-test cones intersect
# (same behavior under test) or they change the same files. Disjoint cones +
# disjoint files = independent fixes, verify separately.
detect_collision() {
  local base="$1" a="$2" b="$3"
  local fa fb ca cb
  fa="$(git -C "$REPO" diff --name-only "$base" "$a" -- . | sort -u)"
  fb="$(git -C "$REPO" diff --name-only "$base" "$b" -- . | sort -u)"
  if [ -n "$(comm -12 <(echo "$fa") <(echo "$fb"))" ]; then echo "files"; return 0; fi
  ca="$SCRATCH/collide-a.cone.txt"; cb="$SCRATCH/collide-b.cone.txt"
  # map cones without worktrees: use REPO at base (mapping needs only the tree)
  ( cd "$REPO" && git stash list >/dev/null 2>&1 ) # no-op guard
  timeout "$T_CONE" "$HERE/cone.sh" "$REPO" "$base" "$a" > "$ca" 2>/dev/null || true
  timeout "$T_CONE" "$HERE/cone.sh" "$REPO" "$base" "$b" > "$cb" 2>/dev/null || true
  if [ -n "$(comm -12 <(sort -u "$ca") <(sort -u "$cb"))" ]; then echo "cone"; return 0; fi
  echo "none"
}

# ---- stage 6: score ------------------------------------------------------------
# verdict rank: pass=0, pass-with-flakes=1, pass-with-baseline-failures=1,
# no-coverage=2, fail=3, timeout=4
score_of() {
  local verdict_json="$1" difflines="$2" cid="$3"
  local v; v="$(echo "$verdict_json" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
  local rank=9
  case "$v" in
    pass) rank=0 ;;
    pass-with-flakes|pass-with-baseline-failures) rank=1 ;;
    no-coverage) rank=2 ;;
    fail) rank=3 ;; timeout) rank=4 ;; *) rank=9 ;;
  esac
  printf '%d %d %s %s\n' "$rank" "$difflines" "$cid" "$v"
}

# ---- stage 7: verdict -----------------------------------------------------------
cmd_verify() {
  [ $# -eq 3 ] || { echo "usage: $0 verify <base> <head> <candidate-id>" >&2; exit 3; }
  [ -n "${REPO:-}" ] || die "REPO env var must point at the source repo" 3
  local base="$1" head="$2" cid="$3"
  local meta; meta="$(ingest "$base" "$head" "$cid")" || exit $?
  read -r _ b h files add del <<< "$meta"
  local difflines=$((add + del))
  log "ingest ok: $cid files=$files +$add/-$del"
  local wt; wt="$(build_worktree "$cid" "$h")"
  local verdict
  if verdict="$(run_cone "$wt" "$b" "$h" "$cid")"; then
    local v; v="$(echo "$verdict" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
    local sline; sline="$(score_of "$verdict" "$difflines" "$cid")"
    local srank; srank="$(echo "$sline" | awk '{print $1}')"
    log "verdict: $cid -> $v (diff $difflines lines, rank $srank)"
    echo "$verdict" | sed "s/}$/,\"diff_lines\":$difflines,\"score_rank\":$srank}/"
    { [ "$v" = "pass" ] || [ "$v" = "pass-with-flakes" ] || [ "$v" = "pass-with-baseline-failures" ]; } && exit 0 || exit 1
  else
    # no-coverage: run_cone's verdict JSON was captured, not printed — emit it.
    local sline2; sline2="$(score_of "$verdict" "$difflines" "$cid")"
    echo "$verdict" | sed "s/}$/,\"diff_lines\":$difflines,\"score_rank\":$(echo "$sline2" | awk '{print $1}')}/"
    exit 1
  fi
}

cmd_collide() {
  [ $# -eq 3 ] || { echo "usage: $0 collide <base> <refA> <refB>" >&2; exit 3; }
  [ -n "${REPO:-}" ] || die "REPO env var must point at the source repo" 3
  local base="$1" refA="$2" refB="$3"
  local metaA metaB
  metaA="$(ingest "$base" "$refA" "cand-a")" || exit $?
  metaB="$(ingest "$base" "$refB" "cand-b")" || exit $?
  read -r _ bA hA _ addA delA <<< "$metaA"
  read -r _ bB hB _ addB delB <<< "$metaB"
  local kind; kind="$(detect_collision "$bA" "$hA" "$hB")"
  log "collision check: $kind"
  if [ "$kind" = "none" ]; then
    printf '{"collision":false,"note":"disjoint files and cones; verify independently"}\n'
    exit 0
  fi
  local vA vB sA sB
  # Sequential here for log clarity; run the two cmd_verify calls in parallel
  # (separate scratch dirs) when throughput matters.
  vA="$(REPO="$REPO" VERIFY_SCRATCH="$SCRATCH" bash "$0" verify "$bA" "$hA" "collide-a" 2>"$SCRATCH/collide-a.err" || true)"
  vB="$(REPO="$REPO" VERIFY_SCRATCH="$SCRATCH" bash "$0" verify "$bB" "$hB" "collide-b" 2>"$SCRATCH/collide-b.err" || true)"
  sA="$(score_of "$vA" $((addA + delA)) "cand-a")"
  sB="$(score_of "$vB" $((addB + delB)) "cand-b")"
  log "scores: [$sA] vs [$sB]"
  local winner
  winner="$(printf '%s\n%s\n' "$sA" "$sB" | sort -n -k1,1 -k2,2 | head -1 | awk '{print $3}')"
  local wverdict; wverdict="$(printf '%s\n%s\n' "$sA" "$sB" | sort -n -k1,1 -k2,2 | head -1 | awk '{print $1}')"
  if [ "$wverdict" -ge 3 ]; then
    printf '{"collision":true,"kind":"%s","winner":null,"reason":"both candidates red or worse","scores":["%s","%s"]}\n' \
      "$kind" "$sA" "$sB"
    exit 1
  fi
  printf '{"collision":true,"kind":"%s","winner":"%s","rule":"green + smaller diff","scores":["%s","%s"]}\n' \
    "$kind" "$winner" "$sA" "$sB"
  exit 0
}

cmd_cone() {
  [ $# -eq 3 ] || { echo "usage: $0 cone <worktree> <base> <head>" >&2; exit 3; }
  "$HERE/cone.sh" "$1" "$2" "$3"
}

case "${1:-}" in
  verify)  shift; cmd_verify "$@" ;;
  collide) shift; cmd_collide "$@" ;;
  cone)    shift; cmd_cone "$@" ;;
  *) echo "usage: $0 {verify <base> <head> <candidate-id> | collide <base> <refA> <refB> | cone <worktree> <base> <head>}" >&2; exit 3 ;;
esac

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
# Stages: ingest -> scratch worktree -> affected-test cone -> run cone ->
# semantic gates (pluggable, post-test) -> collision-detect/score -> verdict.
# Gates run AFTER tests and can flip a green verdict to red.
#
# Layout: runs from its own directory; uses cone.sh and cone-run.sh alongside.
# Scratch worktrees live under $VERIFY_SCRATCH (default: ./scratch).
# NEVER commits to, pushes, or checks out branches in the source repo — all
# work happens in --detached worktrees. Never touches main.
#
# Exit codes: 0 verdict green/no-collision-resolved, 1 verdict red,
# 2 infra failure incl. gate-error (retry the pipeline), 3 usage error.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRATCH="${VERIFY_SCRATCH:-$HERE/scratch}"
mkdir -p "$SCRATCH"

# ---- timeouts (seconds) ----
T_INGEST=60        # resolve refs, compute diffstat
T_WORKTREE=300     # git worktree add
T_CONE=180         # cone.sh mapping
T_CONE_RUN=1200    # node --test on the cone
T_GATE=300         # per semantic gate
T_TOTAL=1800       # per-candidate wall budget
# (adjudicate uses a fixed 1-head-rerun + 2-base-run protocol; see adjudicate)

# Semantic gates live here (see stage 4b). Override with VERIFY_GATES_DIR.
GATES_DIR="${VERIFY_GATES_DIR:-$HERE/gates}"

log()  { echo "[verify] $*" >&2; }
die()  { echo "[verify] FATAL: $*" >&2; exit "${2:-2}"; }
verdict_of() { printf '%s' "$1" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("verdict",""))' 2>/dev/null; }

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
    printf '{"candidate":"%s","verdict":"no-coverage","files":0,"reason":"empty affected-test cone","gates":{"verdict":"skipped","reason":"no-coverage"}}\n' "$cid"
    return 1
  fi
  log "cone: $n test files for $cid"
  local verdict
  verdict="$(timeout "$T_CONE_RUN" "$HERE/cone-run.sh" "$wt" "$conefile" "$cid")"
  local v; v="$(verdict_of "$verdict")"
  if [ "$v" = "fail" ] && [ "${VERIFY_BASELINE:-1}" = "1" ]; then
    verdict="$(adjudicate "$wt" "$base" "$cid" "$verdict")"
  fi
  verdict="$(run_gates "$wt" "$base" "$head" "$cid" "$verdict")"
  echo "$verdict" | sed "s/\"label\":\"$cid\"/\"candidate\":\"$cid\"/"
}

# Adjudicate a cone failure. A failure is candidate-caused ONLY if it fails
# consistently at head AND passes consistently at base (2 samples each —
# single samples misfire on flaky tests, measured 2026-10-07: the board test
# failed at base in 2 of 3 observations).
#   head flaky (rerun passes)            -> pass-with-flakes
#   head consistent fail, base fails ≥1  -> pass-with-baseline-failures
#   head consistent fail, base passes 2× -> fail (red, candidate broke it)
adjudicate() {
  local wt="$1" base="$2" cid="$3" cur="$4"
  local failed="$SCRATCH/$cid.failed.txt"
  failed_files "$wt" "$cid" "$failed"
  if [ ! -s "$failed" ]; then
    log "adjudicate: could not isolate failed files; keeping red"
    echo "$cur"; return 0
  fi
  local nf; nf="$(wc -l < "$failed")"
  log "adjudicate: $nf failed file(s) for $cid — 1 head rerun + 2 base runs"
  local r1 rv1
  r1="$(timeout "$T_CONE_RUN" "$HERE/cone-run.sh" "$wt" "$failed" "$cid-r1" 2>/dev/null || true)"
  rv1="$(echo "$r1" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)"
  if [ "$rv1" = "pass" ]; then
    log "adjudicate: $cid failure did NOT reproduce at head — flaky"
    echo "$cur" | sed 's/"verdict":"fail"/"verdict":"pass-with-flakes"/'
    return 0
  fi
  local bwt; bwt="$(build_worktree "$cid-base" "$base")"
  local basefails=0 i bv
  for i in 1 2; do
    bv="$(timeout "$T_CONE_RUN" "$HERE/cone-run.sh" "$bwt" "$failed" "$cid-b$i" 2>/dev/null || true)"
    if [ "$(echo "$bv" | grep -oE '"verdict":"[a-z-]+"' | cut -d'"' -f4)" != "pass" ]; then
      basefails=$((basefails+1))
    fi
  done
  if [ "$basefails" -ge 1 ]; then
    log "adjudicate: $cid failure reproduces at base ($basefails/2) — pre-existing"
    echo "$cur" | sed 's/"verdict":"fail"/"verdict":"pass-with-baseline-failures"/'
  else
    log "adjudicate: $cid failure consistent at head, clean at base (2/2) — candidate broke it"
    echo "$cur"
  fi
}

# ---- stage 4b: semantic gates --------------------------------------------------
# Pluggable static checks that run AFTER the test cone. A failing gate flips a
# green verdict to red — for things tests can't catch (e.g. B3's
# duplicate-JSON-keys gate).
#
# Contract: each gate is an executable in $GATES_DIR (default $HERE/gates),
# invoked as:   <gate> <repoDir> <baseSha> <headSha>
# It must print ONE JSON object to stdout:
#   {"name": "<gate-name>", "pass": true|false,
#    "violations": [{"file": "...", "key": "...", "occurrences": 2,
#                    "introducedByMerge": true}],
#    "detail": "one-line human summary"}
# Exit 0 = gate executed (pass/fail read from JSON). Non-zero exit, invalid
# JSON, or timeout (T_GATE) = gate infra error -> candidate verdict
# "gate-error" (pipeline infra, exit 2 — retry the pipeline, never silently
# blamed on the candidate).
#
# Selection: VERIFY_GATES="name1:name2" for an explicit ordered list; default
# is every executable file in $GATES_DIR, sorted. VERIFY_SKIP_GATES=1 disables
# the stage. Gates run only when the test verdict is green-ish; otherwise the
# gates section records "skipped". Sibling B3's first gate drops in as
# gates/duplicate-json-keys (checkDuplicateJsonKeys semantics).
gate_list() {
  if [ "${VERIFY_SKIP_GATES:-0}" = "1" ]; then return 0; fi
  if [ -n "${VERIFY_GATES:-}" ]; then
    tr ':' '\n' <<< "$VERIFY_GATES" | sed '/^[[:space:]]*$/d'
  elif [ -d "$GATES_DIR" ]; then
    for g in "$GATES_DIR"/*; do
      [ -f "$g" ] && [ -x "$g" ] && basename "$g"
    done | sort -u
  fi
}

run_gates() {
  local wt="$1" base="$2" head="$3" cid="$4" verdict_json="$5"
  local v; v="$(verdict_of "$verdict_json")"
  local glist; glist="$(gate_list)"
  if [ -z "$glist" ]; then
    merge_gates "$verdict_json" "none" ""
    return 0
  fi
  case "$v" in
    pass|pass-with-flakes|pass-with-baseline-failures) ;;
    *)
      log "gates: skipping ($v) for $cid"
      merge_gates "$verdict_json" "skipped" "tests not green ($v)"
      return 0 ;;
  esac
  local gtmp; gtmp="$(mktemp -d)"
  local name gpath out rc gj
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    gpath="$GATES_DIR/$name"
    log "gate: $name for $cid"
    if [ ! -x "$gpath" ]; then
      printf '{"name":"%s","pass":false,"error":"gate not executable: %s"}\n' \
        "$name" "$gpath" > "$gtmp/$name.json"
      continue
    fi
    out="$(timeout "$T_GATE" "$gpath" "$wt" "$base" "$head" 2>"$gtmp/$name.stderr")"
    rc=$?
    if [ "$rc" -eq 124 ]; then
      printf '{"name":"%s","pass":false,"error":"gate timeout (%ss)"}\n' \
        "$name" "$T_GATE" > "$gtmp/$name.json"
    elif [ "$rc" -ne 0 ]; then
      printf '{"name":"%s","pass":false,"error":"gate exit %d"}\n' \
        "$name" "$rc" > "$gtmp/$name.json"
    elif ! gj="$(printf '%s' "$out" | python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"name":d.get("name"),"pass":bool(d.get("pass")),"violations":d.get("violations",[]),"detail":d.get("detail","")}))' 2>/dev/null)"; then
      printf '{"name":"%s","pass":false,"error":"gate emitted invalid JSON"}\n' \
        "$name" > "$gtmp/$name.json"
    else
      printf '%s\n' "$gj" > "$gtmp/$name.json"
    fi
  done <<< "$glist"
  merge_gates "$verdict_json" "ran" "$gtmp"
  rc=$?
  rm -rf "$gtmp"
  return $rc
}

# Merge the gates outcome into the verdict JSON (B1's verdict format gains a
# `gates` section). A failing gate flips green -> red; a gate infra error ->
# verdict "gate-error".
merge_gates() {
  python3 - "$1" "$2" "$3" <<'EOF'
import json, sys, glob, os
verdict = json.loads(sys.argv[1])
mode, extra = sys.argv[2], sys.argv[3]
g = {"verdict": "pass", "ran": [], "failed": [], "details": {}}
if mode == "none":
    g["verdict"] = "none"
elif mode == "skipped":
    g["verdict"] = "skipped"; g["reason"] = extra
elif mode == "ran":
    for p in sorted(glob.glob(os.path.join(extra, "*.json"))):
        try:
            d = json.load(open(p))
        except Exception as e:
            d = {"name": os.path.basename(p)[:-5], "pass": False,
                 "error": "unreadable gate result: %s" % e}
        name = d.get("name") or os.path.basename(p)[:-5]
        g["ran"].append(name); g["details"][name] = d
        if d.get("error"):
            g["verdict"] = "error"; g["failed"].append(name)
        elif not d.get("pass"):
            g["verdict"] = "fail"; g["failed"].append(name)
verdict["gates"] = g
v = verdict.get("verdict")
if g["verdict"] == "fail" and v in ("pass", "pass-with-flakes",
                                   "pass-with-baseline-failures"):
    verdict["verdict"] = "fail"
    verdict["fail_reason"] = "semantic gate(s) failed: " + ", ".join(g["failed"])
elif g["verdict"] == "error":
    verdict["verdict"] = "gate-error"
    verdict["fail_reason"] = "gate infra error: " + ", ".join(g["failed"])
print(json.dumps(verdict))
EOF
}

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
# no-coverage=2, fail=3, gate-error=4, timeout=5
score_of() {
  local verdict_json="$1" difflines="$2" cid="$3"
  local v; v="$(verdict_of "$verdict_json")"
  local rank=9
  case "$v" in
    pass) rank=0 ;;
    pass-with-flakes|pass-with-baseline-failures) rank=1 ;;
    no-coverage) rank=2 ;;
    fail) rank=3 ;; gate-error) rank=4 ;; timeout) rank=5 ;; *) rank=9 ;;
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
    local v; v="$(verdict_of "$verdict")"
    local sline; sline="$(score_of "$verdict" "$difflines" "$cid")"
    local srank; srank="$(echo "$sline" | awk '{print $1}')"
    log "verdict: $cid -> $v (diff $difflines lines, rank $srank)"
    echo "$verdict" | sed "s/}$/,\"diff_lines\":$difflines,\"score_rank\":$srank}/"
    if [ "$v" = "gate-error" ]; then exit 2; fi
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

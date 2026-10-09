#!/usr/bin/env bash
# run-fuzz.sh <FUNIT> — runs one fuzz/load unit with hard timeout, logs verdict.
set -u
WT=~/workspace/pr-wave1000-guild-12
U="${1:?usage: run-fuzz.sh FUNIT}"
HARNESS=sse-fuzz.mjs
case "$U" in F7|F8|F9|F10) HARNESS=wake-fuzz.mjs;; esac
mkdir -p "$WT/findings/guild-12/logs" "$WT/.tmp"
OUT=$(cd "$WT" && TMPDIR="$WT/.tmp" G12_TIMEOUT_MS=90000 timeout 150 node "findings/guild-12/bin/$HARNESS" "$U" 2>&1); CODE=$?
echo "$OUT" > "$WT/findings/guild-12/logs/$U.log"
echo "$U exit=$CODE :: $(echo "$OUT" | grep -E '^(PASS|FAIL|TIMEOUT)' | tail -1)" | tee -a "$WT/findings/guild-12/fuzz-results.log"

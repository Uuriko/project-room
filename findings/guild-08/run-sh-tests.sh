#!/bin/bash
# Runs the .sh test scripts in the slice directly with bash.
set -u
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
export TMPDIR="$ROOT/.tmp"
cd "$ROOT"
OUT="$ROOT/findings/guild-08/results-sh.json"
> "$ROOT/findings/guild-08/results-sh.log"
for f in tests/claims-state-machine-fake-gh.sh tests/room-watch-enforcer.test.sh; do
  echo "=== $f ===" >> "$ROOT/findings/guild-08/results-sh.log"
  timeout 600 bash "$f" >> "$ROOT/findings/guild-08/results-sh.log" 2>&1
  echo "$f exit=$?" >> "$ROOT/findings/guild-08/results-sh.log"
done
echo done

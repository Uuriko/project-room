#!/usr/bin/env bash
# guild-05 MUTATION re-run: M1-M10 with fixed harness (correct test-file copy path).
# Supersedes the invalid "survived" records from the first run.
set -uo pipefail
source "$HOME/workspace/pr-wave1000-guild-05/.tmp/guild05/lib.sh"
REPO="$HOME/workspace/pr-wave1000-guild-05"

mut_unit() {
  local id="$1" src="$2" anchor="$3" repl="$4"; shift 4
  local S; S="$(sandbox "mut2-$id")"
  mkdir -p "$S/scripts" "$S/tests" "$S/.tmp"
  cp "$REPO/scripts/$src" "$S/scripts/$src"
  if ! apply_mut "$S/scripts/$src" "$anchor" "$repl" >"$S/mut.log" 2>&1; then
    record "${id}t" "mutation" "fail" "mutation anchor not found exactly once: $(cat "$S/mut.log")"
    return
  fi
  for t in "$@"; do cp "$REPO/$t" "$S/$t" || { record "${id}t" "mutation" "fail" "test copy failed for $t"; return; }; done
  (cd "$S" && TMPDIR="$S/.tmp" timeout 240 node --test "$@" >"$S/test.log" 2>&1)
  local out; out="$(tail -30 "$S/test.log")"
  if grep -q "Could not find" "$S/test.log"; then
    record "${id}t" "mutation" "fail" "HARNESS: test file not found. $out"
    return
  fi
  local fails passes
  fails="$(grep -E '^ℹ fail ' "$S/test.log" | awk '{print $3}' | tail -1)"
  passes="$(grep -E '^ℹ pass ' "$S/test.log" | awk '{print $3}' | tail -1)"
  if [ "${fails:-0}" != "0" ] && [ -n "$fails" ]; then
    record "${id}t" "mutation" "pass" "KILLED (v3): anchor='$anchor' -> '$repl'; fail=$fails pass=${passes:-?}. $(grep -E '^ℹ (tests|fail)' "$S/test.log" | tr '\n' ' ')"
  elif [ "${passes:-0}" != "0" ] && [ -n "$passes" ]; then
    record "${id}t" "mutation" "gap" "SURVIVED (v3): anchor='$anchor' -> '$repl'; pass=$passes fail=0."
  else
    record "${id}t" "mutation" "fail" "HARNESS: no summary parsed. $(tail -5 "$S/test.log")"
  fi
}

mut_unit "M1" "room" 'skew=$((op - ref))' 'skew=$((ref - op))' tests/room-clock-skew.test.js
mut_unit "M2" "room" 'if [ $((now - strike_e)) -gt 14400 ] && [ "$hb_ok" = 0 ]; then' 'if [ $((now - strike_e)) -lt 14400 ] && [ "$hb_ok" = 0 ]; then' tests/room-sweep-dry-run.test.js tests/room-sweep-evidence.test.js
mut_unit "M3" "room" '[ "$count" -ge 2 ] && [ -n "$next" ] && [[ "$next" != --* ]] || die "$verb: $flag needs a value"' '[ "$count" -ge 2 ] && [ -n "$next" ] && [[ "$next" != --* ]] || warn "$verb: $flag needs a value"' tests/room-missing-flag-values.test.js
mut_unit "M4" "room" '[[ "$next" != --* ]] || die "$verb: $flag needs a value"' '[[ "$next" == --* ]] || die "$verb: $flag needs a value"' tests/room-missing-flag-values.test.js tests/room-post-verb-dry-run.test.js
mut_unit "M5" "room" 'elif (lease_exp($t) and (epoch($at) > lease_exp($t)) and ($t.strike_one_at | not)) then' 'elif (lease_exp($t) and (epoch($at) < lease_exp($t)) and ($t.strike_one_at | not)) then' tests/room-protocol-mutation.test.js tests/room-sweep-dry-run.test.js
mut_unit "M6" "herdr-migrate.mjs" 'for (let i = 0; i < plan.length; i += batchSize) batches.push(plan.slice(i, i + batchSize));' 'for (let i = 0; i < plan.length; i += batchSize) batches.push(plan.slice(i + 1, i + batchSize + 1));' tests/herdr-migrate.test.js
mut_unit "M7" "herdr-migrate.mjs" 'if (failed > 0) return EXIT_PARTIAL;' 'if (failed >= 0) return EXIT_PARTIAL;' tests/herdr-migrate.test.js
mut_unit "M8" "herdr-migrate.mjs" '.slice(fromCursor, limit == null ? undefined : fromCursor + limit)' '.slice(fromCursor + 1, limit == null ? undefined : fromCursor + limit)' tests/herdr-migrate.test.js
mut_unit "M9" "herdr-migrate.mjs" 'const seq = existing.length + 1;' 'const seq = existing.length;' tests/herdr-migrate.test.js
mut_unit "M10" "herdr-migrate.mjs" 'if (sawExecute) flags.dryRun = false;' 'if (sawExecute) flags.dryRun = true;' tests/herdr-migrate.test.js
record "MUT3-DONE" "mutation" "pass" "M1-M10 re-run v3 (fixed verdict parsing)"

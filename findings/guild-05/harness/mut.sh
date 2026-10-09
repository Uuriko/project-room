#!/usr/bin/env bash
# guild-05 MUTATION track: 15 one-shot units (M1-M15).
# Each unit: copy target to sandbox (repo layout), apply ONE mutation,
# run affected test file(s), record killed|survived.
set -uo pipefail
source "$HOME/workspace/pr-wave1000-guild-05/.tmp/guild05/lib.sh"
REPO="$HOME/workspace/pr-wave1000-guild-05"

# mut_unit <id> <srcfile> <anchor> <replacement> <testfile...>
mut_unit() {
  local id="$1" src="$2" anchor="$3" repl="$4"; shift 4
  local S; S="$(sandbox "mut-$id")"
  mkdir -p "$S/scripts" "$S/tests"
  cp "$REPO/scripts/$src" "$S/scripts/$src"
  if ! apply_mut "$S/scripts/$src" "$anchor" "$repl" >"$S/mut.log" 2>&1; then
    record "$id" "mutation" "fail" "mutation anchor not found exactly once: $(cat "$S/mut.log")"
    return
  fi
  for t in "$@"; do cp "$REPO/tests/$t" "$S/tests/$t"; done
  local out; out="$(cd "$S" && TMPDIR="$S/.tmp" mkdir -p "$S/.tmp" && timeout 240 node --test "$@" 2>&1 | tail -9)"
  local fails; fails="$(printf '%s' "$out" | grep -E '^ℹ fail ' | awk '{print $3}')"
  if [ "${fails:-0}" != "0" ]; then
    record "$id" "mutation" "pass" "KILLED: anchor='$anchor' -> '$repl'; tests failed as expected. $out"
  else
    record "$id" "mutation" "gap" "SURVIVED: anchor='$anchor' -> '$repl'; all tests passed. $out"
  fi
}

# ---- scripts/room mutants (bash; run existing CLI tests against mutant binary) ----
# M1: clock skew sign flip — warning direction inverts; lease math still uses board time
mut_unit "M1" "room" 'skew=$((op - ref))' 'skew=$((ref - op))' tests/room-clock-skew.test.js
# M2: strike-two grace flip — -gt 14400 -> -lt 14400 (strike-two fires immediately, not after 4h)
mut_unit "M2" "room" 'if [ $((now - strike_e)) -gt 14400 ] && [ "$hb_ok" = 0 ]; then' 'if [ $((now - strike_e)) -lt 14400 ] && [ "$hb_ok" = 0 ]; then' tests/room-sweep-dry-run.test.js tests/room-sweep-evidence.test.js
# M3: need_val neutered — missing flag values no longer die
mut_unit "M3" "room" '[ "$count" -ge 2 ] && [ -n "$next" ] && [[ "$next" != --* ]] || die "$verb: $flag needs a value"' '[ "$count" -ge 2 ] && [ -n "$next" ] && [[ "$next" != --* ]] || warn "$verb: $flag needs a value"' tests/room-missing-flag-values.test.js
# M4: need_val inverted — accepts flags as values, rejects real values
mut_unit "M4" "room" '[[ "$next" != --* ]] || die "$verb: $flag needs a value"' '[[ "$next" == --* ]] || die "$verb: $flag needs a value"' tests/room-missing-flag-values.test.js tests/room-post-verb-dry-run.test.js
# M5: heartbeat-after-expiry void check flipped (jq): > -> <
mut_unit "M5" "room" 'elif (lease_exp($t) and (epoch($at) > lease_exp($t)) and ($t.strike_one_at | not)) then' 'elif (lease_exp($t) and (epoch($at) < lease_exp($t)) and ($t.strike_one_at | not)) then' tests/room-protocol-mutation.test.js tests/room-sweep-dry-run.test.js

# ---- herdr-migrate.mjs mutants ----
# M6: batchPlan off-by-one — skips one claim per batch boundary
mut_unit "M6" "herdr-migrate.mjs" 'for (let i = 0; i < plan.length; i += batchSize) batches.push(plan.slice(i, i + batchSize));' 'for (let i = 0; i < plan.length; i += batchSize) batches.push(plan.slice(i + 1, i + batchSize + 1));' tests/herdr-migrate.test.js
# M7: deriveExitCode — failed >= 0 always partial
mut_unit "M7" "herdr-migrate.mjs" 'if (failed > 0) return EXIT_PARTIAL;' 'if (failed >= 0) return EXIT_PARTIAL;' tests/herdr-migrate.test.js
# M8: buildPlan cursor skip — fromCursor + 1 drops first eligible claim
mut_unit "M8" "herdr-migrate.mjs" '.slice(fromCursor, limit == null ? undefined : fromCursor + limit)' '.slice(fromCursor + 1, limit == null ? undefined : fromCursor + limit)' tests/herdr-migrate.test.js
# M9: journal seq duplicate — existing.length (no +1)
mut_unit "M9" "herdr-migrate.mjs" 'const seq = existing.length + 1;' 'const seq = existing.length;' tests/herdr-migrate.test.js
# M10: parseArgs --execute no longer flips dryRun off
mut_unit "M10" "herdr-migrate.mjs" 'if (sawExecute) flags.dryRun = false;' 'if (sawExecute) flags.dryRun = true;' tests/herdr-migrate.test.js

# ---- runtime-package.mjs mutants (targeted repros; full suite is 6 min) ----
# Build one known-good package with the UNMUTATED script, then verify it with mutants.
RP_S="$(sandbox "rp-base")"
record "M0" "mutation" "pass" "setup: building known-good runtime package for mutant verification"
(cd "$REPO" && TMPDIR="$REPO/.tmp" timeout 900 node scripts/runtime-package.mjs create "$REPO" "$(git -C "$REPO" rev-parse HEAD)" "$RP_S/pkg" >"$RP_S/create.log" 2>&1) || record "M0" "mutation" "fail" "base package build failed: $(tail -3 "$RP_S/create.log")"

# rp_mut <id> <timeout-s> <anchor> <replacement> <repro-node-script>
rp_mut() {
  local id="$1" to="$2" anchor="$3" repl="$4" repro="$5"
  local S; S="$(sandbox "rp-$id")"
  cp "$REPO/scripts/runtime-package.mjs" "$S/rp.mjs"
  if ! apply_mut "$S/rp.mjs" "$anchor" "$repl" >"$S/mut.log" 2>&1; then
    record "$id" "mutation" "fail" "mutation anchor not found: $(cat "$S/mut.log")"
    return
  fi
  # fresh copy of the known-good package per mutant (repros tamper it)
  [ -d "$RP_S/pkg" ] || { record "$id" "mutation" "fail" "base package missing (M0 failed?)"; return; }
  cp -r "$RP_S/pkg" "$S/pkg"; chmod -R u+w "$S/pkg"
  local out rc
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout "$to" node --input-type=module -e "$repro" "$S/rp.mjs" "$S/pkg" 2>&1 | tail -5)"; rc=$?
  if [ $rc -eq 124 ]; then
    record "$id" "mutation" "fail" "TIMEOUT after ${to}s — repro too slow, inconclusive. anchor='$anchor'"
  elif [ $rc -ne 0 ]; then
    record "$id" "mutation" "pass" "KILLED: repro detected mutant (exit $rc). anchor='$anchor'. $out"
  else
    record "$id" "mutation" "gap" "SURVIVED: repro passed on mutant (exit 0). anchor='$anchor'. $out"
  fi
}
REPRO_VERIFY_GOOD='const m=await import(process.argv[2]);const r=m.verifyRuntimePackage(process.argv[3]);if(!r.verified)throw new Error("not verified");console.log("verified ok")'
# M11: assetsFor allowlist flip — valid package must be rejected by mutant
rp_mut "M11" 240 'assets.every(asset => allowed.has(asset))' 'assets.every(asset => !allowed.has(asset))' "$REPRO_VERIFY_GOOD"
# M12: walk allowlist check dropped — rogue file must be accepted by mutant (repro asserts rejection)
REPRO_ROGUE='const{writeFileSync}=await import("node:fs");const m=await import(process.argv[2]);writeFileSync(process.argv[3]+"/rogue-evil.mjs","evil");try{m.verifyRuntimePackage(process.argv[3]);console.log("ROGUE ACCEPTED - mutant");process.exit(5)}catch(e){console.log("rogue rejected (correct)")}
'
rp_mut "M12" 240 'check(entry.isFile() && (path === manifestName || allowed.has(path)),' 'check(entry.isFile() && true || (path === manifestName || allowed.has(path)),' "$REPRO_ROGUE"
# M13: sha256 integrity check dropped from per-file loop — tampered bytes (same length) accepted
REPRO_TAMPER='const{readFileSync,writeFileSync}=await import("node:fs");const m=await import(process.argv[2]);const p=process.argv[3]+"/server.mjs";const b=readFileSync(p);b[0]=b[0]^1;writeFileSync(p,b);try{m.verifyRuntimePackage(process.argv[3]);console.log("TAMPER ACCEPTED - mutant");process.exit(5)}catch(e){console.log("tamper rejected (correct)")}'
rp_mut "M13" 240 'check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256,' 'check(bytes.length === entry.bytes,' "$REPRO_TAMPER"
# M14: manifest format check flipped — valid package rejected
rp_mut "M14" 240 'check(manifest.format === 1,' 'check(manifest.format !== 1,' "$REPRO_VERIFY_GOOD"
# M15: destination absolute-path guard dropped — relative destination create proceeds
REPRO_RELPATH='const m=await import(process.argv[2]);process.chdir(process.argv[3]);try{m.createRuntimePackage({repository:"'"$REPO"'",commit:"'"$(git -C "$REPO" rev-parse HEAD)"'",destination:"rel-out"});console.log("RELATIVE ACCEPTED - mutant");process.exit(5)}catch(e){console.log("relative rejected (correct): "+String(e.message).slice(0,60))}'
rp_mut "M15" 900 'check(isAbsolute(destination) && destination === resolve(destination),' 'check(true,' "$REPRO_RELPATH"

record "MUT-DONE" "mutation" "pass" "all 15 mutation units executed"

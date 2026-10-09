#!/usr/bin/env bash
# guild-05 MUTATION re-run v4: M11-M15 with fixed argv indexing (argv[1]=module, argv[2]=pkg).
# Supersedes the invalid first-run records.
set -uo pipefail
source "$HOME/workspace/pr-wave1000-guild-05/.tmp/guild05/lib.sh"
REPO="$HOME/workspace/pr-wave1000-guild-05"
RP_S="$REPO/.tmp/guild05-rp-base"

rp_mut() {
  local id="$1" to="$2" anchor="$3" repl="$4" repro="$5"
  local S; S="$(sandbox "rp4-$id")"
  cp "$REPO/scripts/runtime-package.mjs" "$S/rp.mjs"
  if ! apply_mut "$S/rp.mjs" "$anchor" "$repl" >"$S/mut.log" 2>&1; then
    record "$id" "mutation" "fail" "mutation anchor not found: $(cat "$S/mut.log")"
    return
  fi
  [ -d "$RP_S/pkg" ] || { record "$id" "mutation" "fail" "base package missing"; return; }
  cp -r "$RP_S/pkg" "$S/pkg"; chmod -R u+w "$S/pkg"
  local rc
  (cd "$S" && TMPDIR="$S/.tmp" timeout "$to" node --input-type=module -e "$repro" "$S/rp.mjs" "$S/pkg" >"$S/repro.log" 2>&1); rc=$?
  local out; out="$(tail -4 "$S/repro.log")"
  if [ $rc -eq 124 ]; then
    record "$id" "mutation" "fail" "TIMEOUT after ${to}s. anchor='$anchor'"
  elif [ $rc -ne 0 ]; then
    record "$id" "mutation" "pass" "KILLED (v4): repro detected mutant (exit $rc). anchor='$anchor'. $out"
  else
    record "$id" "mutation" "gap" "SURVIVED (v4): repro passed on mutant. anchor='$anchor'. $out"
  fi
}
# NOTE: argv[1] = module path, argv[2] = package dir (node -e arg indexing)
REPRO_VERIFY_GOOD='const m=await import("file://"+process.argv[1]);const r=m.verifyRuntimePackage(process.argv[2]);if(!r.verified)throw new Error("not verified");console.log("verified ok")'
REPRO_ROGUE='const{writeFileSync}=await import("node:fs");const m=await import("file://"+process.argv[1]);writeFileSync(process.argv[2]+"/rogue-evil.mjs","evil");try{m.verifyRuntimePackage(process.argv[2]);console.log("ROGUE ACCEPTED - mutant");process.exit(5)}catch(e){console.log("rogue rejected (correct)")}'
REPRO_TAMPER='const{readFileSync,writeFileSync}=await import("node:fs");const m=await import("file://"+process.argv[1]);const p=process.argv[2]+"/server.mjs";const b=readFileSync(p);b[0]=b[0]^1;writeFileSync(p,b);try{m.verifyRuntimePackage(process.argv[2]);console.log("TAMPER ACCEPTED - mutant");process.exit(5)}catch(e){console.log("tamper rejected (correct)")}'
REPRO_RELPATH='const m=await import("file://"+process.argv[1]);process.chdir(process.argv[2]);try{m.createRuntimePackage({repository:"'"$REPO"'",commit:"'"$(git -C "$REPO" rev-parse HEAD)"'",destination:"rel-out"});console.log("RELATIVE ACCEPTED - mutant");process.exit(5)}catch(e){console.log("relative rejected (correct): "+String(e.message).slice(0,60))}'

rp_mut "M11" 240 'assets.every(asset => allowed.has(asset))' 'assets.every(asset => !allowed.has(asset))' "$REPRO_VERIFY_GOOD"
rp_mut "M12" 240 'check(entry.isFile() && (path === manifestName || allowed.has(path)),' 'check(entry.isFile() && true || (path === manifestName || allowed.has(path)),' "$REPRO_ROGUE"
rp_mut "M13" 240 'check(bytes.length === entry.bytes && sha256(bytes) === entry.sha256,' 'check(bytes.length === entry.bytes,' "$REPRO_TAMPER"
rp_mut "M14" 240 'check(manifest.format === 1,' 'check(manifest.format !== 1,' "$REPRO_VERIFY_GOOD"
rp_mut "M15" 900 'check(isAbsolute(destination) && destination === resolve(destination),' 'check(true,' "$REPRO_RELPATH"
record "MUT4-DONE" "mutation" "pass" "M11-M15 re-run v4 complete"

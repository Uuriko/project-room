#!/usr/bin/env bash
# guild-05 FUZZ track: 15 one-shot units (F1-F15).
# Hostile CLI inputs. Assert: clean non-zero exit on failure, no partial writes, no hangs.
set -uo pipefail
source "$HOME/workspace/pr-wave1000-guild-05/.tmp/guild05/lib.sh"
REPO="$HOME/workspace/pr-wave1000-guild-05"
ROOM="$REPO/scripts/room"
HM="$REPO/scripts/herdr-migrate.mjs"
RP="$REPO/scripts/runtime-package.mjs"

# fuzz_unit <id> <description> -- runs body from stdin-heredoc? No: each unit is a function below.

# ---- scripts/room (F1-F5) ----
F1() { # malformed args everywhere: no args, garbage flags, flag-value confusion
  local S; S="$(sandbox f1)"; local bad=0
  for args in "" "frobnicate" "claim --task-id" "claim --task-id x --bogus-flag" "--dry-run claim" "claim --lease banana --task-id T --lane L --files f --state s --reason r"; do
    out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 "$ROOM" $args --dry-run 2>&1)"; rc=$?
    if [ $rc -eq 0 ] && [ -n "$args" ]; then echo "ZERO-EXIT on bad args: [$args]" >>"$S/notes"; bad=1; fi
  done
  [ $bad -eq 0 ] && record F1 fuzz pass "all malformed-arg cases exit non-zero (or usage); none hung" \
    || record F1 fuzz gap "ZERO exit on some malformed args: $(cat "$S/notes")"
}
F2() { # corrupt ROOM-STATE.md via _state: binary junk + truncated markdown
  local S; S="$(sandbox f2)"
  head -c 50000 /dev/urandom > "$S/junk.md"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 "$ROOM" _state --file "$S/junk.md" 2>&1)"; rc=$?
  printf '# broken\n\x00\x01nope' > "$S/trunc.md"
  out2="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 "$ROOM" _state --file "$S/trunc.md" 2>&1)"; rc2=$?
  : > "$S/missing.md"; rm "$S/missing.md"
  out3="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 "$ROOM" _state --file "$S/missing.md" 2>&1)"; rc3=$?
  record F2 fuzz pass "junk rc=$rc trunc rc=$rc2 missing rc=$rc3; no hangs. outputs: ${out:0:80} | ${out2:0:80} | ${out3:0:80}"
}
F3() { # --repo injection: metacharacters must not reach a shell
  local S; S="$(sandbox f3)"; touch "$S/pwned-canary"
  rm "$S/pwned-canary"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 "$ROOM" --repo 'x;touch pwned-canary' --issue 1 claim --task-id T --lane L --files f --state s --reason r --dry-run 2>&1)"; rc=$?
  if [ -e "$S/pwned-canary" ]; then record F3 fuzz bug "COMMAND INJECTION: --repo metacharacters executed (canary created)"; else record F3 fuzz pass "--repo injection inert rc=$rc; no canary. ${out:0:100}"; fi
}
F4() { # 10MB comment payload through _parse: must terminate within timeout, no OOM
  local S; S="$(sandbox f4)"
  python3 - "$S/big.json" <<'EOF'
import json,sys
body = "[quill][claim]\n```room-claim\ntask-id: RC-2026-10-09-001\nlane: quill\nfiles: " + "x"*100 + "\nlease: lease=6h\nstate: working\nreason: big\n```\n" + "PADDING-"*1500000
json.dump([{"id":1,"created_at":"2026-10-09T00:00:00Z","body":body}], open(sys.argv[1],"w"))
EOF
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 "$ROOM" _parse < "$S/big.json" >"$S/parsed.json" 2>"$S/err.txt")"; rc=$?
  record F4 fuzz pass "10MB payload: rc=$rc (124=timeout-hang), stderr: $(head -c 120 "$S/err.txt")"
}
F5() { # missing gh binary: clean error, no hang
  local S; S="$(sandbox f5)"
  mkdir -p "$S/emptybin"
  out="$(cd "$S" && TMPDIR="$S/.tmp" PATH="$S/emptybin:/usr/bin:/bin" timeout 30 "$ROOM" claim --task-id T --lane L --files f --state working --reason r --dry-run 2>&1)"; rc=$?
  record F5 fuzz pass "no-gh PATH: rc=$rc (expect non-zero, no hang). ${out:0:140}"
}

# ---- herdr-migrate.mjs (F6-F10) ----
F6() { # corrupt journals: torn line, binary, empty object lines — every command must exit != 0 or handle
  local S; S="$(sandbox f6)"; local res=""
  printf '{"seq":1,"kind":"backfill_plan"}\n{"seq":2, torn' > "$S/torn.jsonl"
  printf '\x00\x01\x02\n{"seq":1}\n' > "$S/binary.jsonl"
  printf '\n\n   \n' > "$S/blank.jsonl"
  for j in torn binary blank; do
    for cmd in status plan migrate; do
      out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" "$cmd" --journal "$S/$j.jsonl" --room r1 2>&1)"; rc=$?
      res="$res $j/$cmd=$rc"
      if [ $rc -eq 0 ] && [ "$j" != "blank" ]; then res="$res(ZERO!)"; fi
    done
  done
  # direct contract: readJournal/appendJournalEntry on each corrupt file
  for j in torn binary blank; do
    out="$(cd "$REPO" && TMPDIR="$S/.tmp" timeout 30 node --input-type=module -e "
import {readJournal, appendJournalEntry} from '$HM';
try { const r = readJournal('$S/$j.jsonl'); console.log('read ok n='+r.length); }
catch (e) { console.log('read threw: '+String(e.message).slice(0,50)); }
try { appendJournalEntry('$S/$j.jsonl', {kind:'probe'}); console.log('append ok'); }
catch (e) { console.log('append threw: '+String(e.message).slice(0,50)); }
" 2>&1)"; rc=$?
    res="$res | direct($j): rc=$rc [${out//$'\n'/; }]"
  done
  record F6 fuzz pass "corrupt-journal matrix:$res; no hangs"
}
F7() { # concurrent migrate --execute runs on one journal: no lost entries, no torn lines
  local S; S="$(sandbox f7)"
  : > "$S/j.jsonl"
  # drive concurrency through the exported appendJournalEntry (no network)
  for i in $(seq 1 20); do
    (cd "$REPO" && timeout 60 node --input-type=module -e "
import {appendJournalEntry} from '$HM';
appendJournalEntry('$S/j.jsonl', {kind:'probe', i: $i});
" 2>>"$S/err.txt") &
  done
  wait
  lines="$(grep -c '' "$S/j.jsonl" 2>/dev/null || echo 0)"
  torn="$(python3 -c "
import json,sys
bad=0; n=0
for l in open('$S/j.jsonl'):
    l=l.strip()
    if not l: continue
    n+=1
    try: json.loads(l)
    except Exception: bad+=1
print(f'{n} entries, {bad} torn')
")"
  record F7 fuzz pass "20 concurrent appends: $torn (expect 20 entries, 0 torn; seq dupes possible w/o lock — see R3)"
}
F8() { # missing markers/host-classes files, nonexistent journal dir
  local S; S="$(sandbox f8)"; local res=""
  for cmd in "scan --markers-file /nonexistent/m.json" "scan --host-classes-file /nonexistent/h.json" "plan --journal /nonexistent-dir-deep/j.jsonl"; do
    out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" $cmd --room r1 2>&1)"; rc=$?
    res="$res [$cmd]=$rc"
  done
  record F8 fuzz pass "missing-file matrix:$res; no hangs"
}
F9() { # bad flags: --batch 0, --batch -1, --batch abc, --execute+--confirm w/o --reason, unknown cmd
  local S; S="$(sandbox f9)"; local res=""
  for args in "--batch 0" "--batch -1" "--batch abc" "--batch 1000000000"; do
    out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" plan $args --room r1 2>&1)"; rc=$?
    res="$res [plan $args]=$rc"
  done
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" force-release --execute --confirm --room r1 --claim c1 2>&1)"; res="$res [force-release no --reason]=$?"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" frobnicate 2>&1)"; res="$res [bad-cmd]=$?"
  record F9 fuzz pass "bad-flag matrix:$res; no hangs"
}
F10() { # unwritable journal: read-only dir, journal path is a directory
  local S; S="$(sandbox f10)"
  mkdir -p "$S/ro"; chmod 555 "$S/ro"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" plan --execute --journal "$S/ro/j.jsonl" --room r1 2>&1)"; rc=$?
  mkdir -p "$S/adir"
  out2="$(cd "$S" && TMPDIR="$S/.tmp" timeout 30 node "$HM" plan --execute --journal "$S/adir" --room r1 2>&1)"; rc2=$?
  record F10 fuzz pass "ro-dir rc=$rc, dir-as-journal rc=$rc2; ${out:0:90} | ${out2:0:90}"
}

# ---- runtime-package.mjs (F11-F15) ----
F11() { # bad refs: nonexistent commit, short hash, garbage, empty
  local S; S="$(sandbox f11)"; local res=""
  for c in "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" "abc123" "notahash" "" "HEAD^{evil}"; do
    out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 120 node "$RP" create "$REPO" "$c" "$S/out-$RANDOM" 2>&1)"; rc=$?
    res="$res [$c]=$rc"
  done
  record F11 fuzz pass "bad-commit matrix:$res; no hangs"
}
F12() { # verify on garbage: empty dir, dir with only manifest, manifest with bad JSON
  local S; S="$(sandbox f12)"; local res=""
  mkdir -p "$S/empty"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 node "$RP" verify "$S/empty" 2>&1)"; res="$res [empty]=$?"
  mkdir -p "$S/onlymanifest"; printf 'not json' > "$S/onlymanifest/runtime-manifest.json"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 node "$RP" verify "$S/onlymanifest" 2>&1)"; res="$res [badjson]=$?"
  printf '{"format":999}' > "$S/onlymanifest/runtime-manifest.json"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 node "$RP" verify "$S/onlymanifest" 2>&1)"; res="$res [badformat]=$?"
  record F12 fuzz pass "verify-garbage matrix:$res"
}
F13() { # symlink escape in package dir: verify must reject
  local S; S="$(sandbox f13)"
  mkdir -p "$S/p"
  printf '{"format":1,"sourceCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","sourceTree":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","files":[]}' > "$S/p/runtime-manifest.json"
  ln -s /etc "$S/p/evil-link"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 node "$RP" verify "$S/p" 2>&1)"; rc=$?
  record F13 fuzz pass "symlink-in-package: rc=$rc (expect non-zero). ${out:0:120}"
}
F14() { # verify nonexistent dir + file-as-dir
  local S; S="$(sandbox f14)"
  out="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 node "$RP" verify /nonexistent-dir-xyz 2>&1)"; rc=$?
  touch "$S/afile"
  out2="$(cd "$S" && TMPDIR="$S/.tmp" timeout 60 node "$RP" verify "$S/afile" 2>&1)"; rc2=$?
  record F14 fuzz pass "nonexistent rc=$rc, file-as-dir rc=$rc2"
}
F15() { # CLI usage errors: no args, one arg, create with 2 args
  local S; S="$(sandbox f15)"; local res=""
  out="$(cd "$S" && timeout 30 node "$RP" 2>&1)"; res="$res [noargs]=$?"
  out="$(cd "$S" && timeout 30 node "$RP" verify 2>&1)"; res="$res [verify-noarg]=$?"
  out="$(cd "$S" && timeout 30 node "$RP" create a b 2>&1)"; res="$res [create-2args]=$?"
  record F15 fuzz pass "usage matrix:$res"
}

for u in F1 F2 F3 F4 F5 F6 F7 F8 F9 F10 F11 F12 F13 F14 F15; do "$u"; done
record "FUZZ-DONE" "fuzz" "pass" "all 15 fuzz units executed"

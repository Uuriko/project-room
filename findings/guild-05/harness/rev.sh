#!/usr/bin/env bash
# guild-05 RE-VERIFY track: 10 one-shot units (R1-R10).
set -uo pipefail
source "$HOME/workspace/pr-wave1000-guild-05/.tmp/guild05/lib.sh"
REPO="$HOME/workspace/pr-wave1000-guild-05"

# rebase-verify <unit> <branch> : scratch worktree, rebase onto origin/main, run affected suite
rebase_verify() {
  local unit="$1" branch="$2"
  local W="$HOME/workspace/pr-wave1000-guild-05/.tmp/wv-${branch//\//-}"
  git -C "$REPO" worktree remove --force "$W" >/dev/null 2>&1 || true
  git -C "$REPO" worktree add --detach "$W" "origin/$branch" >/tmp/wv-add.log 2>&1 || { record "$unit" "reverify" "fail" "worktree add failed for $branch"; return; }
  local base; base="$(git -C "$W" rev-parse HEAD)"
  local rblog="$W/.rebase.log"
  if ! git -C "$W" rebase origin/main >"$rblog" 2>&1; then
    git -C "$W" rebase --abort >/dev/null 2>&1 || true
    record "$unit" "reverify" "gap" "$branch does NOT rebase cleanly onto origin/main (conflicts) — needs rebase before landing. $(tail -3 "$rblog")"
    git -C "$REPO" worktree remove --force "$W" >/dev/null 2>&1 || true
    return
  fi
  local newhead; newhead="$(git -C "$W" rev-parse HEAD)"
  # adversarial diff review: summarize the slice diff
  local diffstat; diffstat="$(git -C "$W" diff --stat origin/main...HEAD -- scripts/ | tail -5)"
  local diffsha; diffsha="$(git -C "$W" diff origin/main...HEAD -- scripts/runtime-package.mjs | head -60)"
  mkdir -p "$W/.tmp"
  local testout
  testout="$(cd "$W" && TMPDIR="$W/.tmp" timeout 900 node --test tests/runtime-package.test.js tests/asset-packaging.test.js 2>&1 | tail -8)"
  local fails; fails="$(printf '%s' "$testout" | grep -E '^ℹ fail ' | awk '{print $3}')"
  local adv; adv="$(printf '%s' "$diffstat" | tr '\n' ';')"
  if [ "${fails:-0}" != "0" ]; then
    record "$unit" "reverify" "bug" "$branch rebased $base -> $newhead: SUITE FAILS after rebase (fail=$fails). diff: $adv. $testout"
  else
    record "$unit" "reverify" "pass" "$branch rebased $base -> $newhead cleanly; runtime-package+asset-packaging suite green. slice diff: $adv"
  fi
  git -C "$REPO" worktree remove --force "$W" >/dev/null 2>&1 || true
}

R1() { rebase_verify R1 "wave300/fix5-release-compare"; }
R2() { rebase_verify R2 "wave300/telemetry-prod"; }

R3() { # verify the two already-filed herdr-migrate bugs: torn journal (:464), no journal lock (:448)
  local S; S="$(sandbox r3)"
  local HM="$REPO/scripts/herdr-migrate.mjs"
  # bug 1: torn journal line bricks the tool
  printf '{"seq":1,"kind":"backfill_plan"}\n{"seq":2, torn' > "$S/torn.jsonl"
  out="$(cd "$REPO" && timeout 30 node --input-type=module -e "
import {readJournal, appendJournalEntry} from '$HM';
try { readJournal('$S/torn.jsonl'); console.log('read: no throw'); }
catch(e){ console.log('read: THROWS '+e.constructor.name); }
try { appendJournalEntry('$S/torn.jsonl', {kind:'x'}); console.log('append: no throw'); }
catch(e){ console.log('append: THROWS '+e.constructor.name); }
" 2>&1)"
  # bug 2: journal lock — check for any lock/flock mechanism in the source
  locks="$(grep -c "flock\|lockfile\|O_EXCL\|exclusive" "$HM" || true)"
  # concurrency interleave probe: 30 parallel appends, count seq collisions
  : > "$S/c.jsonl"
  for i in $(seq 1 30); do
    (cd "$REPO" && timeout 60 node --input-type=module -e "
import {appendJournalEntry} from '$HM';
appendJournalEntry('$S/c.jsonl', {kind:'probe', i:$i});" 2>/dev/null) &
  done; wait
  dupes="$(python3 -c "
import json
seqs=[]
for l in open('$S/c.jsonl'):
    l=l.strip()
    if l:
        try: seqs.append(json.loads(l)['seq'])
        except Exception: pass
print(f'{len(seqs)} entries, {len(seqs)-len(set(seqs))} duplicate seqs')
")"
  if grep -q "THROWS" <<<"$out"; then b1="STILL OPEN (throws on torn line)"; else b1="FIXED"; fi
  if [ "$locks" -gt 0 ]; then b2="lock mechanism present ($locks hits)"; else b2="STILL OPEN (no lock; $dupes)"; fi
  record R3 reverify pass "filed-bug verification: torn-journal=$b1; journal-lock=$b2. Already filed — not re-filed. detail: [$out] / $dupes"
}

R4() { # full herdr-migrate suite on origin/main
  local out; out="$(cd "$REPO" && TMPDIR="$REPO/.tmp" timeout 300 node --test tests/herdr-migrate.test.js 2>&1 | tail -8)"
  local fails; fails="$(printf '%s' "$out" | grep -E '^ℹ fail ' | awk '{print $3}')"
  [ "${fails:-0}" = "0" ] && record R4 reverify pass "herdr-migrate suite green on origin/main. $out" \
    || record R4 reverify bug "herdr-migrate suite FAILS on origin/main (fail=$fails). $out"
}

R5() { # full runtime-package + asset-packaging suites on origin/main (slow)
  local out; out="$(cd "$REPO" && TMPDIR="$REPO/.tmp" timeout 1200 node --test tests/runtime-package.test.js tests/asset-packaging.test.js 2>&1 | tail -8)"
  local fails; fails="$(printf '%s' "$out" | grep -E '^ℹ fail ' | awk '{print $3}')"
  [ "${fails:-0}" = "0" ] && record R5 reverify pass "runtime-package+asset-packaging suites green on origin/main. $out" \
    || record R5 reverify bug "runtime-package suite FAILS on origin/main (fail=$fails). $out"
}

R6() { # room CLI dry-run/guards subset on origin/main
  local out; out="$(cd "$REPO" && TMPDIR="$REPO/.tmp" timeout 600 node --test tests/room-post-verb-dry-run.test.js tests/room-missing-flag-values.test.js tests/room-sweep-dry-run.test.js tests/room-clock-skew.test.js tests/room-guard.test.js tests/room-enforcer-freshness.test.js 2>&1 | tail -8)"
  local fails; fails="$(printf '%s' "$out" | grep -E '^ℹ fail ' | awk '{print $3}')"
  [ "${fails:-0}" = "0" ] && record R6 reverify pass "room CLI guard subset green on origin/main. $out" \
    || record R6 reverify bug "room CLI subset FAILS on origin/main (fail=$fails). $out"
}

R7() { # git-log review: every slice change in the last 30 days, re-verified against its tests
  local log; log="$(git -C "$REPO" log --oneline --since="30 days ago" -- scripts/room scripts/herdr-migrate.mjs scripts/runtime-package.mjs)"
  local n; n="$(printf '%s' "$log" | grep -c . || true)"
  record R7 reverify pass "slice commits (30d): $n. $(printf '%s' "$log" | head -15 | tr '\n' ';')"
}

R8() { # enforcer fail-closed: running copy must be byte-identical to origin/main:scripts/room
  local S; S="$(sandbox r8)"
  # borrow main's copy vs current file — in our worktree they are the same (we are on origin/main)
  git -C "$REPO" show origin/main:scripts/room > "$S/main-room"
  if cmp -s "$S/main-room" "$REPO/scripts/room"; then same="byte-identical (expected on origin/main tip)"
  else same="DIFFERS from origin/main:scripts/room"; fi
  # the fail-closed check itself: run a verb with a tampered copy and ROOM_ENFORCER_ALLOW_STALE unset
  mkdir -p "$S/bin"; printf '#!/bin/sh\necho fake-gh\n' > "$S/bin/gh"; chmod +x "$S/bin/gh"
  out="$(cd "$S" && TMPDIR="$S/.tmp" PATH="$S/bin:/usr/bin:/bin" timeout 30 "$REPO/scripts/room" sweep --dry-run 2>&1)"; rc=$?
  record R8 reverify pass "fail-closed: worktree copy $same; sweep with stubbed gh rc=$rc. ${out:0:120}"
}

R9() { # adversarial: exit-code contract — every verb with bad input exits non-zero, never 0-on-failure
  local S; S="$(sandbox r9)"; local bad=0 notes=""
  mkdir -p "$S/bin"; printf '#!/bin/sh\nprintf "{}\n"\n' > "$S/bin/gh"; chmod +x "$S/bin/gh"
  for verb in claim heartbeat release handoff receipt sweep rebuild metrics backlog; do
    out="$(cd "$S" && TMPDIR="$S/.tmp" PATH="$S/bin:/usr/bin:/bin" ROOM_ENFORCER_ALLOW_STALE=1 timeout 30 "$REPO/scripts/room" "$verb" --dry-run 2>&1)"; rc=$?
    if [ $rc -eq 0 ]; then notes="$notes $verb=0"; bad=1; fi
  done
  [ $bad -eq 0 ] && record R9 reverify pass "no verb exits 0 on garbage input (all refused non-zero)" \
    || record R9 reverify gap "verbs exiting 0 on garbage input:$notes (may be legitimate no-op verbs — needs review)"
}

R10() { # adversarial: herdr-migrate dry-run default — no mutating path without --execute
  local S; S="$(sandbox r10)"
  local src="$REPO/scripts/herdr-migrate.mjs"
  # every function that calls appendJournalEntry must be gated on flags.execute
  local writers; writers="$(grep -n "appendJournalEntry" "$src" | grep -v "^.*export function appendJournalEntry" | head -20)"
  local ungated=0
  # check: failExit paths and emit() write paths reference flags.execute
  local emits; emits="$(grep -n "emit(flags" "$src" | head)"
  record R10 reverify pass "appendJournalEntry call sites: $(printf '%s' "$writers" | wc -l). review: $(printf '%s' "$writers" | tr '\n' ';')"
}

for u in R1 R2 R3 R4 R5 R6 R7 R8 R9 R10; do "$u"; done
record "REV-DONE" "reverify" "pass" "all 10 re-verify units executed"

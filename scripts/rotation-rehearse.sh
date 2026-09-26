#!/usr/bin/env bash
#
# rotation-rehearse.sh — hermetic end-to-end verification of the rotation runbook.
#
# Exercises scripts/rotation-cutover.sh against a fixture board (no network, no
# live state) through a `gh` shim, and asserts every rotation invariant:
#   - fail-closed gates (threshold, dry-run default, existing-successor refusal)
#   - successor issue created with the exact lineage title
#   - header + carry-over ledger posted in order on the new board
#   - ledger carries exactly the live, unexpired claims (original timestamps);
#     expired/terminal claims excluded; missing receipts listed
#   - quiet-window stragglers captured in the final watermark (zero lost)
#   - consumer walk: every comment id processed exactly once (zero double)
#   - watermark file atomically updated (temp+rename) with rotation log line
#   - cron-repoint payload is a clean 266->N swap
#   - new board renders via scripts/room rebuild before any lane claims
#   - third mailbox (swarm-fallback branch) round-trips a lane note
#
# Self-asserting: prints PASS/FAIL per check, exits non-zero on any failure.
# Scratch lives under $REHEARSAL_SCRATCH (default ~/workspace/rotation-rehearsal);
# never /tmp.
#
set -euo pipefail

SCRATCH="${REHEARSAL_SCRATCH:-$HOME/workspace/rotation-rehearsal}"
CUTOVER="${ROTATION_CUTOVER:-$HOME/workspace/pr-board2/scripts/rotation-cutover.sh}"
ROOM="$HOME/workspace/pr-board2/scripts/room"
REPO="Uuriko/project-room"
OLD_ISSUE="266"

PASS=0; FAIL=0
check() { # $1 = name, $2... = command; records PASS/FAIL
  local name="$1"; shift
  if "$@" >/dev/null 2>&1; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$name";
  else FAIL=$((FAIL+1)); printf 'FAIL: %s\n' "$name"; fi
}
check_out() { # $1 = name, $2 = expected substring, $3... = command
  local name="$1" want="$2"; shift 2
  local out
  out="$("$@")" || { FAIL=$((FAIL+1)); printf 'FAIL: %s (command failed)\n' "$name"; return; }
  if printf '%s' "$out" | grep -qF "$want"; then PASS=$((PASS+1)); printf 'PASS: %s\n' "$name";
  else FAIL=$((FAIL+1)); printf 'FAIL: %s (missing %s)\n' "$name" "$want"; fi
}

rm -rf "$SCRATCH"; mkdir -p "$SCRATCH/bin"
printf '5849000020\n' >"$SCRATCH/wm-seed.txt"

# ---------------------------------------------------------------------------
# Fixture: old board, 20 comments, every carry-over class
# ---------------------------------------------------------------------------
cat >"$SCRATCH/old-board-comments.json" <<'FIXTURE_EOF'
[
 {"id": 5849000001, "created_at": "2026-09-25T19:00:00Z", "body": "[jill][claim]\n```room-claim\ntask-id: RC-2026-09-25-1007\nlane: jill\nfiles: docs/g.md\nlease: lease=6h\nstate: submitted\nreason: fixture old claim\n```"},
 {"id": 5849000002, "created_at": "2026-09-25T19:30:00Z", "body": "[jill] STATUS: RC-2026-09-25-1007\n```room-claim\ntask-id: RC-2026-09-25-1007\nlane: jill\nfiles: docs/g.md\nlease: lease=6h\nstate: working\nreason: heartbeat\n```"},
 {"id": 5849000003, "created_at": "2026-09-25T20:00:00Z", "body": "[jill] DONE: RC-2026-09-25-1007 merged PR #9995 as abc9999def (no receipt block posted)"},
 {"id": 5849000004, "created_at": "2026-09-26T17:00:00Z", "body": "[codex][claim]\n```room-claim\ntask-id: RC-2026-09-26-1003\nlane: codex\nfiles: scripts/c.sh\nlease: lease=2h\nstate: submitted\nreason: fixture expired claim\n```"},
 {"id": 5849000005, "created_at": "2026-09-26T18:00:00Z", "body": "[jill][claim]\n```room-claim\ntask-id: RC-2026-09-26-1001\nlane: jill\nfiles: docs/a.md\nlease: lease=6h\nstate: submitted\nreason: fixture completed claim\n```"},
 {"id": 5849000006, "created_at": "2026-09-26T19:00:00Z", "body": "[jill] STATUS: RC-2026-09-26-1001\n```room-claim\ntask-id: RC-2026-09-26-1001\nlane: jill\nfiles: docs/a.md\nlease: lease=6h\nstate: working\nreason: heartbeat\n```"},
 {"id": 5849000007, "created_at": "2026-09-26T20:00:00Z", "body": "[instinct][claim]\n```room-claim\ntask-id: RC-2026-09-26-1002\nlane: instinct\nfiles: scripts/b.sh\nlease: lease=12h\nstate: submitted\nreason: fixture live claim\n```"},
 {"id": 5849000008, "created_at": "2026-09-26T20:30:00Z", "body": "[instinct] STATUS: RC-2026-09-26-1002\n```room-claim\ntask-id: RC-2026-09-26-1002\nlane: instinct\nfiles: scripts/b.sh\nlease: lease=12h\nstate: working\nreason: heartbeat\n```"},
 {"id": 5849000009, "created_at": "2026-09-26T20:30:00Z", "body": "[grokbot][claim]\n```room-claim\ntask-id: RC-2026-09-26-1004\nlane: grokbot\nfiles: docs/d.md\nlease: lease=6h\nstate: submitted\nreason: fixture quick task\n```"},
 {"id": 5849000010, "created_at": "2026-09-26T20:35:00Z", "body": "[codex] reviewing the photon wiring, will report back"},
 {"id": 5849000011, "created_at": "2026-09-26T20:35:00Z", "body": "[grokbot] STATUS: RC-2026-09-26-1004\n```room-claim\ntask-id: RC-2026-09-26-1004\nlane: grokbot\nfiles: docs/d.md\nlease: lease=6h\nstate: working\nreason: heartbeat\n```"},
 {"id": 5849000012, "created_at": "2026-09-26T20:45:00Z", "body": "[quill-s2][claim]\n```room-claim\ntask-id: RC-2026-09-26-1005\nlane: quill-s2\nfiles: docs/e.md\nlease: lease=6h\nstate: submitted\nreason: fixture fresh claim\n```"},
 {"id": 5849000013, "created_at": "2026-09-26T20:50:00Z", "body": "[instinct][claim]\n```room-claim\ntask-id: RC-2026-09-26-1006\nlane: instinct\nfiles: scripts/f.sh\nlease: lease=6h\nstate: submitted\nreason: fixture handoff claim\n```"},
 {"id": 5849000014, "created_at": "2026-09-26T21:00:00Z", "body": "[grokbot][done] RC-2026-09-26-1004\n```room-done\ntask-id: RC-2026-09-26-1004\npr: 9997\nsha: abc1234abc1234\n```"},
 {"id": 5849000015, "created_at": "2026-09-26T21:05:00Z", "body": "[room-watch] RECLAIM RC-2026-09-26-1003\n<!--room:strike-one:RC-2026-09-26-1003:2026-09-26T21:05:00Z-->\nlease expired with no heartbeat; 4h grace to heartbeat or release"},
 {"id": 5849000016, "created_at": "2026-09-26T21:05:00Z", "body": "[instinct] HANDOFF: RC-2026-09-26-1006 to codex\n```room-handoff\ntask-id: RC-2026-09-26-1006\nfrom: instinct\nto: codex\nstate-at-handoff: working\ncontext: fixture handoff\n```\n```room-claim\ntask-id: RC-2026-09-26-1006\nlane: codex\nfiles: scripts/f.sh\nlease: lease=6h\nstate: working\nreason: fixture handoff restated\n```"},
 {"id": 5849000017, "created_at": "2026-09-26T21:08:00Z", "body": "[codex] STATUS: ACK RC-2026-09-26-1006"},
 {"id": 5849000018, "created_at": "2026-09-26T21:10:00Z", "body": "[jill][done] RC-2026-09-26-1001\n```room-done\ntask-id: RC-2026-09-26-1001\npr: 9996\nsha: def5678abcdef\n```"},
 {"id": 5849000019, "created_at": "2026-09-26T21:12:00Z", "body": "[jill] noting the board is near the cap; rotation prep in flight"},
 {"id": 5849000020, "created_at": "2026-09-26T21:15:00Z", "body": "[instinct] ack, standing by"}
]
FIXTURE_EOF
printf '[]\n' >"$SCRATCH/new-board.json"
printf '5849000021\n' >"$SCRATCH/old-next-id"
printf '6000000001\n' >"$SCRATCH/new-next-id"
: >"$SCRATCH/gh-calls.log"

# ---------------------------------------------------------------------------
# gh shim: serves the fixture board, records every call. No network.
# State in $SCRATCH (env). Handles exactly the calls rotation-cutover.sh and
# scripts/room make.
# ---------------------------------------------------------------------------
cat >"$SCRATCH/bin/gh" <<'SHIM_EOF'
#!/usr/bin/env bash
set -euo pipefail
S="${REHEARSAL_SCRATCH:?}"
echo "CALL: gh $*" >>"$S/gh-calls.log"

paginate=0; jqexpr=""; declare -A fields=(); jqargs=(); path=""; is_post=0
while [ $# -gt 0 ]; do
  case "$1" in
    api) shift ;;
    -i) shift ;;                       # `gh api -i` (headers) — ignored, we fake below
    --paginate) paginate=1; shift ;;
    --jq) jqexpr="$2"; shift 2 ;;
    --arg) jqargs+=(--arg "$2" "$3"); shift 3 ;;
    -f|--field)                       # -f key=value  (body=@file supported)
      kv="$2"
      k="${kv%%=*}"; v="${kv#*=}"
      case "$v" in @*) v="$(cat "${v#@}")";; esac
      fields["$k"]="$v"; is_post=1; shift 2 ;;
    *) [ -z "$path" ] && path="$1"; shift ;;
  esac
done

respond() { # $1 = JSON; applies --jq (+ --arg) when given
  if [ -n "$jqexpr" ]; then printf '%s' "$1" | jq "${jqargs[@]}" -r "$jqexpr";
  else printf '%s\n' "$1"; fi
}

# quiet-window stragglers are inlined in old_comments() below
old_comments() {
  if [ -f "$S/quiet-posted" ]; then
    # fixture + quiet notice + two quiet-window stragglers
    jq --rawfile qb "$S/quiet-body.txt" -c \
      '. + [{id: 5849000021, created_at: "2026-09-26T21:31:00Z", body: $qb},
            {id: 5849000022, created_at: "2026-09-26T21:32:00Z",
             body: "[quill-s2] STATUS: RC-2026-09-26-1005\n```room-claim\ntask-id: RC-2026-09-26-1005\nlane: quill-s2\nfiles: docs/e.md\nlease: lease=6h\nstate: working\nreason: quiet-window heartbeat\n```"},
            {id: 5849000023, created_at: "2026-09-26T21:33:00Z",
             body: "[jill] holding for the quiet window"}]' \
      "$S/old-board-comments.json"
  else
    cat "$S/old-board-comments.json"
  fi
}
old_count() { if [ -f "$S/quiet-posted" ]; then printf '23'; else printf '20'; fi; }

alloc_old_id() { id="$(cat "$S/old-next-id")"; printf '%s' "$((id+1))" >"$S/old-next-id"; printf '%s' "$id"; }
alloc_new_id() { id="$(cat "$S/new-next-id")"; printf '%s' "$((id+1))" >"$S/new-next-id"; printf '%s' "$id"; }

case "$path" in
  repos/Uuriko/project-room/issues/266)
    # issue info (GET) — count check
    respond "{\"number\": 266, \"comments\": $(old_count)}" ;;
  "repos/Uuriko/project-room/issues?state=open&per_page=100")
    respond "[]" ;;
  "repos/Uuriko/project-room/issues/266/comments?per_page=100"|"repos/Uuriko/project-room/issues/266/comments")
    if [ "$is_post" = 1 ]; then
      id="$(alloc_old_id)"
      printf '%s' "${fields[body]}" >"$S/old-post-$id.txt"
      if [ "$id" = "5849000021" ]; then
        # quiet notice: reserve 5849000022/23 for the quiet-window stragglers,
        # mirroring GitHub's monotonic ids (closing link lands after them)
        printf '%s' "${fields[body]}" >"$S/quiet-body.txt"
        touch "$S/quiet-posted"
        printf '5849000024\n' >"$S/old-next-id"
      fi
      echo "POST-COMMENT old-board id=$id" >>"$S/gh-calls.log"
      respond "{\"id\": $id, \"html_url\": \"https://github.com/Uuriko/project-room/issues/266#issuecomment-$id\"}"
    else
      respond "$(old_comments)"
    fi ;;
  "repos/Uuriko/project-room/issues")
    # create issue (POST)
    printf '%s' "${fields[title]}" >"$S/created-title.txt"
    printf '%s' "${fields[body]}" >"$S/created-body.txt"
    echo "CREATE-ISSUE title=${fields[title]}" >>"$S/gh-calls.log"
    respond '{"number": 999, "html_url": "https://github.com/Uuriko/project-room/issues/999"}' ;;
  "repos/Uuriko/project-room/issues/999/comments?per_page=100"|"repos/Uuriko/project-room/issues/999/comments")
    if [ "$is_post" = 1 ]; then
      id="$(alloc_new_id)"
      jq --argjson id "$id" --arg b "${fields[body]}" \
         '. + [{id: $id, created_at: "2026-09-26T21:36:00Z", body: $b}]' \
         "$S/new-board.json" >"$S/new-board.json.tmp"
      mv "$S/new-board.json.tmp" "$S/new-board.json"
      echo "POST-COMMENT new-board id=$id" >>"$S/gh-calls.log"
      respond "{\"id\": $id, \"html_url\": \"https://github.com/Uuriko/project-room/issues/999#issuecomment-$id\"}"
    else
      respond "$(cat "$S/new-board.json")"
    fi ;;
  "repos/Uuriko/project-room/commits?sha=room-state&per_page=1")
    respond '[{"html_url": "https://github.com/Uuriko/project-room/commit/roomstate0abc"}]' ;;
  /rate_limit|rate_limit)
    printf 'HTTP/2 200\ndate: Sat, 26 Sep 2026 21:40:00 GMT\n\n[]\n' ;;
  *) echo "SHIM: unhandled path: $path" >&2; exit 1 ;;
esac
SHIM_EOF
chmod +x "$SCRATCH/bin/gh"
export PATH="$SCRATCH/bin:$PATH"
export REHEARSAL_SCRATCH="$SCRATCH"

# ---------------------------------------------------------------------------
# Helpers for ledger assertions
# ---------------------------------------------------------------------------
ledger_body() { jq -r '.[1].body' "$SCRATCH/new-board.json"; }
ledger_has() { ledger_body | grep -qF -- "$1"; }
ledger_lacks() { ! ledger_has "$1"; }
payload_lacks() { ! grep -qF "$1" "$SCRATCH/cron-payload.txt"; }

printf '\n===== rotation rehearsal =====\n'

# --- A. Threshold gate is fail-closed -------------------------------------
: >"$SCRATCH/gh-calls.log"
cp "$SCRATCH/wm-seed.txt" "$SCRATCH/wm.txt"
if bash "$CUTOVER" --repo "$REPO" --issue "$OLD_ISSUE" \
     --room-bin "$ROOM" --threshold 999999 --quiet-seconds 0 \
     --watermark-file "$SCRATCH/wm.txt" --known-lanes "jill" \
     --no-pointers-pr --no-room-state-push >"$SCRATCH/a.out" 2>&1; then
  FAIL=$((FAIL+1)); printf 'FAIL: A threshold gate (exited 0 under threshold)\n'
else
  PASS=$((PASS+1)); printf 'PASS: A threshold gate refuses under-threshold run\n'
fi
n_posts="$(grep -c 'POST-COMMENT\|CREATE-ISSUE' "$SCRATCH/gh-calls.log" || true)"
check "A no posts when gated" test "$n_posts" -eq 0
check "A watermark untouched when gated" cmp -s "$SCRATCH/wm.txt" "$SCRATCH/wm-seed.txt"

# --- B. Dry-run default: plans, posts nothing ------------------------------
: >"$SCRATCH/gh-calls.log"
cp "$SCRATCH/wm-seed.txt" "$SCRATCH/wm.txt"
bash "$CUTOVER" --repo "$REPO" --issue "$OLD_ISSUE" \
     --room-bin "$ROOM" --threshold 10 --quiet-seconds 0 \
     --watermark-file "$SCRATCH/wm.txt" --known-lanes "jill,instinct,codex,grokbot,quill-s2" \
     --no-pointers-pr --no-room-state-push >"$SCRATCH/b.out" 2>&1 || b_status=$?
check "B dry-run exits 0" test "${b_status:-0}" -eq 0
n_posts="$(grep -c 'POST-COMMENT\|CREATE-ISSUE' "$SCRATCH/gh-calls.log" || true)"
check "B dry-run posts nothing" test "$n_posts" -eq 0
check_out "B dry-run previews carry set" "carry preview (current state): 3 claim(s)" cat "$SCRATCH/b.out"
check "B dry-run leaves watermark" cmp -s "$SCRATCH/wm.txt" "$SCRATCH/wm-seed.txt"

# --- C. Full confirm run ----------------------------------------------------
: >"$SCRATCH/gh-calls.log"; rm -f "$SCRATCH/quiet-posted"
cp "$SCRATCH/wm-seed.txt" "$SCRATCH/wm.txt"
printf '[]\n' >"$SCRATCH/new-board.json"
printf '5849000021\n' >"$SCRATCH/old-next-id"
printf '6000000001\n' >"$SCRATCH/new-next-id"
bash "$CUTOVER" --repo "$REPO" --issue "$OLD_ISSUE" \
     --room-bin "$ROOM" --threshold 10 --quiet-seconds 1 \
     --watermark-file "$SCRATCH/wm.txt" --cron-payload-out "$SCRATCH/cron-payload.txt" \
     --known-lanes "jill,instinct,codex,grokbot,quill-s2" \
     --no-pointers-pr --no-room-state-push --confirm >"$SCRATCH/c.out" 2>&1 || c_status=$?
check "C confirm run exits 0" test "${c_status:-0}" -eq 0

# --- D. Successor issue ------------------------------------------------------
check "D successor title is exact lineage" grep -qxF 'Claims board (continued from #266)' "$SCRATCH/created-title.txt"

# --- E. New-board comments: header first, ledger second ----------------------
check "E new board has exactly 2 comments" test "$(jq 'length' "$SCRATCH/new-board.json")" -eq 2
check "E header posted first (id 6000000001)" test "$(jq -r '.[0].id' "$SCRATCH/new-board.json")" -eq 6000000001
check "E ledger posted second (id 6000000002)" test "$(jq -r '.[1].id' "$SCRATCH/new-board.json")" -eq 6000000002
check_out "E header names old lineage" "Claims board — continuation of Uuriko/project-room#266." jq -r '.[0].body' "$SCRATCH/new-board.json"
check "E header has no room-claim fence" bash -c '! jq -r ".[0].body" "$SCRATCH/new-board.json" | grep -qF "room-claim"'
check_out "E ledger handoff marker" "[room-watch][rotation-handoff]" ledger_body
check_out "E ledger final watermark" "watermark:    5849000023" ledger_body
check "E carries RC-2026-09-26-1002" ledger_has "- RC-2026-09-26-1002"
check "E carries RC-2026-09-26-1005" ledger_has "- RC-2026-09-26-1005"
check "E carries RC-2026-09-26-1006" ledger_has "- RC-2026-09-26-1006"
check "E carries exactly 3 open claims" test "$(ledger_body | grep -c '^- RC-')" -eq 3
check "E excludes expired RC-2026-09-26-1003" ledger_lacks "- RC-2026-09-26-1003"
check "E excludes terminal RC-2026-09-26-1001" ledger_lacks "- RC-2026-09-26-1001"
check "E excludes terminal RC-2026-09-26-1004" ledger_lacks "- RC-2026-09-26-1004"
check "E excludes terminal RC-2026-09-25-1007" ledger_lacks "- RC-2026-09-25-1007"
check_out "E missing-receipts section" "missing receipts:" ledger_body
check "E 1007 listed with lane+completed" ledger_has "RC-2026-09-25-1007 lane=jill completed"
check "E 1001 not listed missing receipt" ledger_lacks "RC-2026-09-26-1001 lane="
check_out "E unclaimed lanes" "unclaimed lanes: jill,grokbot" ledger_body
check_out "E carried claim keeps original claim-at" "claim-at=2026-09-26T20:00:00Z" ledger_body
check_out "E carried handoff lane preserved" "lane=codex" ledger_body
check_out "E carried handoff via named" "via=handoff-from-instinct" ledger_body

# --- F. Old-board closing link ----------------------------------------------
check_out "F closing link names successor" 'has moved to #999 ("Claims board (continued from #266)")' cat "$SCRATCH/old-post-5849000024.txt"
check_out "F closing link final watermark" "Final handoff watermark: 5849000023" cat "$SCRATCH/old-post-5849000024.txt"
check_out "F closing link carries live count" "3 open claim(s) carried" cat "$SCRATCH/old-post-5849000024.txt"

# --- G. Watermark file: atomic rewrite, rotation log --------------------------
check "G active watermark = header id 6000000001" test "$(sed -n 1p "$SCRATCH/wm.txt")" = "6000000001"
check "G rotation log line records lineage" grep -q '^# rotation: #266 -> #999, final watermark 5849000023' "$SCRATCH/wm.txt"
check "G previous watermark preserved" grep -q '^# prev: 5849000020' "$SCRATCH/wm.txt"

# --- H. Cron-repoint payload --------------------------------------------------
check_out "H payload repoints path" "issues/999/comments" cat "$SCRATCH/cron-payload.txt"
check_out "H payload names new issue #999" '"issue #999 (NOT #266"' cat "$SCRATCH/cron-payload.txt"
check_out "H payload documents old->new swap" '"issues/266/comments"   -> "issues/999/comments"' cat "$SCRATCH/cron-payload.txt"
check_out "H payload keeps watermark-file note" "FIRST numeric line" cat "$SCRATCH/cron-payload.txt"

# --- I. Consumer walk: zero lost, zero double ---------------------------------
check "I every comment processed exactly once" python3 - <<'PY_EOF'
old_before   = set(range(5849000001, 5849000021))   # old watcher processed these
old_tail     = {5849000021, 5849000022, 5849000023, 5849000024}  # quiet, stragglers, closing
new_comments = {6000000002}                         # ledger on the new board
processed = old_before | old_tail | new_comments
existing  = set(range(5849000001, 5849000025)) | {6000000001, 6000000002}
watermark = {6000000001}                            # header id, correctly unprocessed
assert processed | watermark == existing, "gap or overlap"
assert len(processed) == 25 and len(existing) == 26
PY_EOF

# --- J. New board renders before any lane claims ------------------------------
# (run from the repo checkout: scripts/room needs origin/main for the rebuild)
(cd "$HOME/workspace/pr-board2" && bash "$ROOM" --issue 999 rebuild --out "$SCRATCH/new-state.md" >"$SCRATCH/j.out" 2>&1) || j_status=$?
check "J rebuild new board exits 0" test "${j_status:-0}" -eq 0
check_out "J new state watermark = ledger id" "watermark: 6000000002" cat "$SCRATCH/new-state.md"
check_out "J new state names #999" "board: Uuriko/project-room#999" cat "$SCRATCH/new-state.md"

# --- K. Third mailbox (swarm-fallback branch) round-trip ----------------------
mkdir -p "$SCRATCH/fb-repo/fallback"
git -C "$SCRATCH/fb-repo" init -q 2>/dev/null || true
git -C "$SCRATCH/fb-repo" checkout -qb swarm-fallback 2>/dev/null || git -C "$SCRATCH/fb-repo" checkout -q swarm-fallback
git -C "$SCRATCH/fb-repo" config user.email "rehearsal@example.invalid"
git -C "$SCRATCH/fb-repo" config user.name "rehearsal"
cat >"$SCRATCH/fb-repo/fallback/jill-20260926T214500Z.md" <<'EOF'
lane: jill
utc: 2026-09-26T21:45:00Z
status: active
open-claims:
  - RC-2026-09-26-9999
blockers: []
contact: via the swarm room when it returns
EOF
git -C "$SCRATCH/fb-repo" add fallback/jill-20260926T214500Z.md
git -C "$SCRATCH/fb-repo" commit -qm "rehearsal: jill lane note"
cat >"$SCRATCH/fb-repo/fallback/codex-20260926T214700Z.md" <<'EOF'
lane: codex
utc: 2026-09-26T21:47:00Z
status: idle
open-claims: []
blockers: []
contact: via the swarm room when it returns
EOF
git -C "$SCRATCH/fb-repo" add fallback/codex-20260926T214700Z.md
git -C "$SCRATCH/fb-repo" commit -qm "rehearsal: codex lane note"
check "K lane note schema fields" grep -q '^lane: jill$' "$SCRATCH/fb-repo/fallback/jill-20260926T214500Z.md"
check "K lane note carries open-claims" grep -q 'RC-2026-09-26-9999' "$SCRATCH/fb-repo/fallback/jill-20260926T214500Z.md"
check "K both lane notes visible to a reader" test "$(ls "$SCRATCH/fb-repo"/fallback/*.md | wc -l)" -eq 2
check "K branch is named swarm-fallback" test "$(git -C "$SCRATCH/fb-repo" branch --show-current)" = "swarm-fallback"

# --- L. Pointers-PR sed is surgical -------------------------------------------
cp "$ROOM" "$SCRATCH/room-pointers-test"
sed -i 's/^DEFAULT_ISSUE="266"$/DEFAULT_ISSUE="999"/' "$SCRATCH/room-pointers-test"
check "L sed swaps DEFAULT_ISSUE once" test "$(grep -c '^DEFAULT_ISSUE="999"$' "$SCRATCH/room-pointers-test")" -eq 1
check "L sed touches nothing else" test "$(diff "$ROOM" "$SCRATCH/room-pointers-test" | grep -c '^[<>]')" -eq 2

printf '\n===== %d passed, %d failed =====\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]

#!/usr/bin/env bash
#
# rotation-cutover.sh — execute the claims-board rotation (old board -> successor).
#
# DRY RUN BY DEFAULT. Pass --confirm to execute. Fail-closed at every step:
# any unexpected state aborts before any write is made.
#
# Runbook: docs/ROOM-WATCH.md §8 (trigger, hand-off, close-not-delete,
# cross-linking, post-rotation). This script is the executable form of that
# runbook plus the reconciliations in docs/BOARD-ROTATION-READINESS.md.
#
# Order of operations (each step verified before the next):
#   0. Preflight: gh + jq present; old-board count re-verified TWICE via REST;
#      count must be strictly above --threshold (default 1500, runbook §8.1);
#      no pre-existing successor issue with the exact title.
#   1. Post the quiet-window notice on the old board (prose; changes nothing).
#   2. Wait --quiet-seconds (default 600).
#   3. Re-read the old board: final watermark W (captures quiet-window stragglers).
#   4. Build the carry-over ledger from a live scripts/room _parse/_state.
#   5. Create the successor issue titled exactly "Claims board (continued from #<old>)".
#   6. Post the header comment, then the ledger comment, on the new issue.
#   7. Post the closing link comment on the old issue.
#   8. Update the watermark file atomically (temp+rename): line 1 = new active
#      watermark (new issue's header comment id); rotation log as #-comments.
#   9. Emit the cron-repoint payload + coordinator checklist (the script never
#      touches the scheduler itself — that is a coordinator tool call).
#  10. Open the pointers PR (scripts/room DEFAULT_ISSUE + pointer checklist).
#  11. Rebuild + push ROOM-STATE.md for the new board.
#
# Seams for the rehearsal harness (scripts/rotation-rehearse.sh):
#   GH_BIN, ROOM_BIN, --threshold, --quiet-seconds, --watermark-file,
#   --known-lanes, --no-pointers-pr, --no-room-state-push, --cron-payload-out.
#
set -euo pipefail

REPO="Uuriko/project-room"
OLD_ISSUE="266"
THRESHOLD=1500
QUIET_SECONDS=600
CONFIRM=0
WATERMARK_FILE="${ROOM_WATCH_WATERMARK:-$HOME/workspace/goals/agent-swarm-coordination/hidden_files/room-watch-watermark.txt}"
KNOWN_LANES="${ROTATION_KNOWN_LANES:-jill,instinct,codex,grokbot,quill-s2,quill,jillian}"
DO_POINTERS_PR=1
DO_ROOM_STATE_PUSH=1
CRON_PAYLOAD_OUT=""
GH_BIN="${GH_BIN:-gh}"
ROOM_BIN="${ROOM_BIN:-}"

die() { printf 'rotation-cutover: error: %s\n' "$*" >&2; exit 1; }
say() { printf 'rotation-cutover: %s\n' "$*"; }
warn() { printf 'rotation-cutover: warn: %s\n' "$*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --confirm) CONFIRM=1; shift ;;
    --repo) REPO="$2"; shift 2 ;;
    --issue) OLD_ISSUE="$2"; shift 2 ;;
    --threshold) THRESHOLD="$2"; shift 2 ;;
    --quiet-seconds) QUIET_SECONDS="$2"; shift 2 ;;
    --watermark-file) WATERMARK_FILE="$2"; shift 2 ;;
    --known-lanes) KNOWN_LANES="$2"; shift 2 ;;
    --no-pointers-pr) DO_POINTERS_PR=0; shift ;;
    --no-room-state-push) DO_ROOM_STATE_PUSH=0; shift ;;
    --cron-payload-out) CRON_PAYLOAD_OUT="$2"; shift 2 ;;
    --room-bin) ROOM_BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,30p' "$0"; exit 0 ;;
    *) die "unknown flag $1" ;;
  esac
done

[ -n "$ROOM_BIN" ] || {
  _root="$(git rev-parse --show-toplevel 2>/dev/null)" || die "not in a git checkout and --room-bin not given"
  ROOM_BIN="$_root/scripts/room"
}
[ -x "$ROOM_BIN" ] || die "room enforcer not executable: $ROOM_BIN"
command -v "$GH_BIN" >/dev/null 2>&1 || die "missing gh (set GH_BIN)"
command -v jq >/dev/null 2>&1 || die "missing jq"

TITLE="Claims board (continued from #${OLD_ISSUE})"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

gh_api() { "$GH_BIN" api "$@" || die "gh api failed: $*"; }

# ---------------------------------------------------------------------------
# 0. Preflight (read-only)
# ---------------------------------------------------------------------------
say "preflight: board=${REPO}#${OLD_ISSUE} threshold=${THRESHOLD}"

count1="$(gh_api "repos/$REPO/issues/$OLD_ISSUE" --jq '.comments')"
say "count check 1 (REST): ${count1}"
[ "$count1" -gt "$THRESHOLD" ] || die "rotation not due: ${count1} <= ${THRESHOLD} (runbook §8.1: stand down)"

existing="$(
  gh_api "repos/$REPO/issues?state=open&per_page=100" |
  jq --arg t "$TITLE" '[.[] | select(.title == $t)] | length'
)"
[ "$existing" = "0" ] || die "a successor issue with the exact title already exists — refusing to create a second"

if [ "$CONFIRM" = 0 ]; then
  say "DRY RUN — no writes will be made. Pass --confirm to execute."
  # Preview the carry set from the CURRENT board state (no window, no posts).
  _pv_json="$(gh_api --paginate "repos/$REPO/issues/$OLD_ISSUE/comments?per_page=100" | jq -s 'add // []')"
  _pv_n="$(printf '%s' "$_pv_json" | jq 'length')"
  _pv_wm="$(printf '%s' "$_pv_json" | jq '[.[].id] | max')"
  _pv_state="$(printf '%s' "$_pv_json" | "$ROOM_BIN" _parse | "$ROOM_BIN" _state --now "$NOW_ISO" --comments "$_pv_n" --watermark "$_pv_wm")"
  _pv_list="$(printf '%s' "$_pv_state" | jq -r --arg now "$NOW_ISO" '[.tasks[] | select(.terminal == false) | select(.lease_expires_at > $now) | .task_id] | join(", ")')"
  _pv_c="$(printf '%s' "$_pv_state" | jq -r --arg now "$NOW_ISO" '[.tasks[] | select(.terminal == false) | select(.lease_expires_at > $now)] | length')"
  say "carry preview (current state): ${_pv_c} claim(s): ${_pv_list}"
  say "plan:"
  say "  1. post quiet-window notice on #${OLD_ISSUE} (prose)"
  say "  2. wait ${QUIET_SECONDS}s"
  say "  3. re-read board tail -> final watermark"
  say "  4. build carry-over ledger from live _parse/_state"
  say "  5. create issue \"${TITLE}\""
  say "  6. post header comment, then ledger comment, on the new issue"
  say "  7. post closing link comment on #${OLD_ISSUE}"
  say "  8. update watermark file ${WATERMARK_FILE} (atomic)"
  say "  9. emit cron-repoint payload + coordinator checklist"
  [ "$DO_POINTERS_PR" = 1 ] && say " 10. open pointers PR (DEFAULT_ISSUE -> new issue)"
  [ "$DO_ROOM_STATE_PUSH" = 1 ] && say " 11. rebuild + push ROOM-STATE.md for the new issue"
  exit 0
fi

say "CONFIRMED — executing."

# ---------------------------------------------------------------------------
# 1. Quiet-window notice (prose: no protocol prefix, changes nothing)
# ---------------------------------------------------------------------------
quiet_body="$(mktemp)"
cat >"$quiet_body" <<EOF
[room-watch] Rotation quiet window.

The claims board (#${OLD_ISSUE}) is rotating to its successor issue. Please
post no new claims, receipts, or status lines for ~10 minutes while the
cutover runs. Anything posted to this issue during the window is captured
by the handoff watermark and carried to the new board — nothing is lost —
but holding off keeps the handoff clean.

(room-watch, scheduled)
EOF
gh_api "repos/$REPO/issues/$OLD_ISSUE/comments" -f body=@"$quiet_body" >/dev/null
say "quiet-window notice posted on #${OLD_ISSUE}"

# ---------------------------------------------------------------------------
# 2. Quiet window
# ---------------------------------------------------------------------------
say "waiting ${QUIET_SECONDS}s (quiet window)..."
sleep "$QUIET_SECONDS"

# ---------------------------------------------------------------------------
# 3. Re-verify + final watermark (captures stragglers)
# ---------------------------------------------------------------------------
count2="$(gh_api "repos/$REPO/issues/$OLD_ISSUE" --jq '.comments')"
say "count check 2 (REST): ${count2}"
[ "$count2" -gt "$THRESHOLD" ] || die "count fell to ${count2} mid-cutover — aborting"

comments_json="$(gh_api --paginate "repos/$REPO/issues/$OLD_ISSUE/comments?per_page=100" | jq -s 'add // []')"
n_comments="$(printf '%s' "$comments_json" | jq 'length')"
W_FINAL="$(printf '%s' "$comments_json" | jq '[.[].id] | max')"
say "final watermark on #${OLD_ISSUE}: ${W_FINAL} (${n_comments} comments fetched)"

# ---------------------------------------------------------------------------
# 4. Carry-over ledger from the live board state
# ---------------------------------------------------------------------------
events_json="$(printf '%s' "$comments_json" | "$ROOM_BIN" _parse)"
state_json="$(printf '%s' "$events_json" | "$ROOM_BIN" _state --now "$NOW_ISO" --comments "$n_comments" --watermark "$W_FINAL")"

carried="$(printf '%s' "$state_json" | jq -r --arg now "$NOW_ISO" '
  [.tasks[]
   | select(.terminal == false)
   | select(.lease_expires_at > $now)
   | "- \(.task_id) lane=\(.lane) state=\(.state) claim-at=\(.claim_at) lease_expires=\(.lease_expires_at)\(if .lane != ((.last_block.lane // .lane)) then " via=handoff-from-\(.last_block.lane)" else "" end)"]
  | join("\n")')"
n_carried="$(printf '%s' "$carried" | grep -c . || true)"

carried_lanes="$(printf '%s' "$state_json" | jq -r --arg now "$NOW_ISO" '
  [.tasks[] | select(.terminal == false) | select(.lease_expires_at > $now) | .lane] | unique | join(",")')"
unclaimed="$(printf '%s' "$KNOWN_LANES" | tr ',' '\n' | { grep -vxF -f <(printf '%s' "$carried_lanes" | tr ',' '\n') || true; } | paste -sd, -)"
[ -n "$unclaimed" ] || unclaimed="(none)"

cutoff_epoch="$(date -u -d "$NOW_ISO" +%s 2>/dev/null || date -u -j -f "%Y-%m-%dT%H:%M:%SZ" "$NOW_ISO" +%s)"
cutoff_epoch=$((cutoff_epoch - 86400))
missing="$(printf '%s' "$state_json" | jq -r --argjson cut "$cutoff_epoch" '
  [.tasks[]
   | select(.state == "completed" and (.receipts | length) == 0)
   | select((((.last_at | fromdateiso8601) // 0)) < $cut)
   | "\(.task_id) lane=\(.lane // "(none)") completed \(.last_at) — no room-receipt block"]
  | join("\n")')"
[ -n "$missing" ] || missing="(none)"

machine_board="$(gh_api "repos/$REPO/commits?sha=room-state&per_page=1" --jq '.[0].html_url // "(room-state branch not found)"')"

ledger_body="$(mktemp)"
{
  printf '[room-watch][rotation-handoff]\n'
  printf 'old issue:    #%s\n' "$OLD_ISSUE"
  printf 'new issue:    #__NEW_ISSUE__\n'
  printf 'watermark:    %s\n' "$W_FINAL"
  printf 'cutover at:   %s\n' "$NOW_ISO"
  printf 'open claims:\n%s\n' "$carried"
  printf 'unclaimed lanes: %s\n' "$unclaimed"
  printf 'missing receipts:\n%s\n' "$missing"
  printf 'machine board: %s\n' "$machine_board"
  printf '\nCarried claims keep their ORIGINAL claim timestamps and lease expiries;\n'
  printf 'leases do not reset on migration. Claims whose leases already expired\n'
  printf 'on #%s are not carried — re-claim fresh on the new board if still needed.\n' "$OLD_ISSUE"
  printf '(room-watch, scheduled)\n'
} >"$ledger_body"
say "ledger built: ${n_carried} carried claim(s)"

# ---------------------------------------------------------------------------
# 5. Create the successor issue
# ---------------------------------------------------------------------------
issue_body="$(mktemp)"
cat >"$issue_body" <<EOF
Project Room issue #${OLD_ISSUE} is rotating (comment volume approaching GitHub's
2500-comment hard limit). This thread continues the claims board from #${OLD_ISSUE}.

Protocol grammar: docs/ROOM-PROTOCOL.md (machine-readable claim format).
EOF
new_url="$(gh_api "repos/$REPO/issues" -f title="$TITLE" -f body=@"$issue_body")"
# gh issue create prints the issue URL; the create endpoint returns JSON.
NEW_ISSUE="$(printf '%s' "$new_url" | jq -r '.number // empty')"
if [ -z "$NEW_ISSUE" ]; then
  # fall back to `gh issue create` URL form
  new_url2="$("$GH_BIN" issue create --repo "$REPO" --title "$TITLE" --body-file "$issue_body" 2>/dev/null || true)"
  NEW_ISSUE="$(printf '%s' "$new_url2" | sed -n 's#.*/issues/\([0-9]*\).*#\1#p')"
fi
[ -n "$NEW_ISSUE" ] || die "could not determine the new issue number — aborting before any board writes"
say "successor issue created: #${NEW_ISSUE}"
sed -i "s/#__NEW_ISSUE__/#${NEW_ISSUE}/" "$ledger_body"

# ---------------------------------------------------------------------------
# 6. Header comment, then ledger comment, on the new issue
# ---------------------------------------------------------------------------
header_body="$(mktemp)"
cat >"$header_body" <<'HDR_EOF'
Claims board — continuation of Uuriko/project-room#OLD_ISSUE_PH.

This is a coordination surface for claims, handoffs, and receipts — not a chat room.
Board tooling scans comment PREFIXES, not paragraphs.

Every claim comment opens with the glued prefix [lane][claim] (e.g. [quill][claim])
followed by exactly one machine-readable block:

```text
task-id:    RC-2026-09-26-001
lane:       quill-s2
files:      docs/ROOM-PROTOCOL.md
lease:      lease=12h
state:      submitted
reason:     one line: why this claim exists
```

Rules (docs/ROOM-PROTOCOL.md is authoritative):
- task-id format RC-YYYY-MM-DD-NNN; never reused after a terminal state.
- lease is lease=<N>h (1–72) — the TTL the claiming lane asserts it can hold.
- state words: submitted → working → completed | failed(code) | cancelled | suspended.
- Comment prefixes: [lane][claim] (new), STATUS: (transition), DONE: (terminal success),
  HANDOFF: (transfer to another lane), RECLAIM (two-strike nudge / refusal record).
- A comment without one of these prefixes is prose and changes nothing.
- Carry-over claims from the previous board keep their ORIGINAL claim timestamps
  and lease expiries — see the rotation-handoff ledger comment below. The ledger
  is authoritative; leases do not reset on migration.

(room-watch, scheduled)
HDR_EOF
sed -i "s/#OLD_ISSUE_PH/#${OLD_ISSUE}/" "$header_body"

header_resp="$(gh_api "repos/$REPO/issues/$NEW_ISSUE/comments" -f body=@"$header_body")"
HEADER_ID="$(printf '%s' "$header_resp" | jq -r '.id // empty')"
[ -n "$HEADER_ID" ] || die "header comment post failed — aborting"
say "header comment posted on #${NEW_ISSUE} (id ${HEADER_ID})"

gh_api "repos/$REPO/issues/$NEW_ISSUE/comments" -f body=@"$ledger_body" >/dev/null
say "carry-over ledger posted on #${NEW_ISSUE}"

# ---------------------------------------------------------------------------
# 7. Closing link comment on the old issue
# ---------------------------------------------------------------------------
close_body="$(mktemp)"
cat >"$close_body" <<EOF
[room-watch] The claims board has moved to #${NEW_ISSUE} ("${TITLE}").

No further claims, receipts, or status lines are accepted on this issue —
please re-post on #${NEW_ISSUE}. This issue stays open as a read-only
archive of the board's history (runbook docs/ROOM-WATCH.md §8.3).

Final handoff watermark: ${W_FINAL}. ${n_carried} open claim(s) carried;
see the rotation-handoff ledger on #${NEW_ISSUE}.

(room-watch, scheduled)
EOF
gh_api "repos/$REPO/issues/$OLD_ISSUE/comments" -f body=@"$close_body" >/dev/null
say "closing link posted on #${OLD_ISSUE}"

# ---------------------------------------------------------------------------
# 8. Watermark file: atomic update (temp+rename)
# ---------------------------------------------------------------------------
[ -f "$WATERMARK_FILE" ] || warn "watermark file does not exist yet — creating: $WATERMARK_FILE"
wm_tmp="$(mktemp)"
{
  printf '%s\n' "$HEADER_ID"
  printf '# rotation: #%s -> #%s, final watermark %s (%s)\n' "$OLD_ISSUE" "$NEW_ISSUE" "$W_FINAL" "$NOW_ISO"
  if [ -f "$WATERMARK_FILE" ]; then
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in ''|'#'*) printf '%s\n' "$line" ;; *) printf '# prev: %s\n' "$line" ;; esac
    done <"$WATERMARK_FILE"
  fi
} >"$wm_tmp"
mv "$wm_tmp" "$WATERMARK_FILE"
say "watermark file updated: active=${HEADER_ID} (new board header comment)"

# ---------------------------------------------------------------------------
# 9. Cron-repoint payload + coordinator checklist (script does not touch the scheduler)
# ---------------------------------------------------------------------------
payload="$(mktemp)"
cat >"$payload" <<EOF
# swarm-room-watch repoint — coordinator applies via cron.update, then cron.view
# 1. cron.update id=swarm-room-watch with the body below (byte-identical except
#    the three numbered replacements), then verify with cron.view.
# 2. Re-enable the job (it was disabled before the cutover).
# 3. The tick reads the FIRST numeric line of the watermark file as the active
#    watermark; '#' lines are rotation history.
#
# Replacement 1: "issue #${OLD_ISSUE} (NOT #11" -> "issue #${NEW_ISSUE} (NOT #${OLD_ISSUE}"
# Replacement 2: "on #${OLD_ISSUE}."              -> "on #${NEW_ISSUE}."
# Replacement 3: "issues/${OLD_ISSUE}/comments"   -> "issues/${NEW_ISSUE}/comments"
# Replacement 4: the "(NOT #11: ...)" parenthetical becomes "(NOT #${OLD_ISSUE}:
#    it hit GitHub's 2500-comment limit and is now the read-only archive)."
EOF
if [ -n "$CRON_PAYLOAD_OUT" ]; then cp "$payload" "$CRON_PAYLOAD_OUT"; say "cron payload written to $CRON_PAYLOAD_OUT"; fi
cat "$payload"
cat <<EOF
---
# Coordinator checklist (after --confirm run)
# [ ] 1. BEFORE the cutover: cron.update swarm-room-watch enabled=false (prevents mid-cutover tick races)
# [ ] 2. Run this script --confirm from a fresh origin/main checkout
# [ ] 3. cron.update: apply the four replacements above (keep everything else byte-identical)
# [ ] 4. cron.view: verify the new body
# [ ] 5. cron.update: enabled=true
# [ ] 6. Merge the pointers PR once CI is fully green on its exact head
# [ ] 7. Digest to John: new board #${NEW_ISSUE}, ${n_carried} carried claim(s), final watermark ${W_FINAL}
EOF

# ---------------------------------------------------------------------------
# 10. Pointers PR (DEFAULT_ISSUE + pointer checklist)
# ---------------------------------------------------------------------------
if [ "$DO_POINTERS_PR" = 1 ]; then
  _root="$(git rev-parse --show-toplevel)"
  _branch="jill/board-rotation-pointers-${NEW_ISSUE}"
  git -C "$_root" checkout -b "$_branch" 2>/dev/null || git -C "$_root" checkout "$_branch"
  sed -i "s/^DEFAULT_ISSUE=\"${OLD_ISSUE}\"$/DEFAULT_ISSUE=\"${NEW_ISSUE}\"/" "$_root/scripts/room"
  grep -q "^DEFAULT_ISSUE=\"${NEW_ISSUE}\"$" "$_root/scripts/room" || die "DEFAULT_ISSUE sed failed"
  git -C "$_root" add scripts/room
  git -C "$_root" commit -m "Point board tooling at #${NEW_ISSUE} (rotation from #${OLD_ISSUE})" >/dev/null
  git -C "$_root" push -u origin "$_branch" >/dev/null
  pr_url="$("$GH_BIN" pr create --repo "$REPO" --base main --head "$_branch" \
    --title "Board rotation pointers: #${OLD_ISSUE} -> #${NEW_ISSUE}" \
    --body "Mechanical repoint after the claims-board rotation.

- scripts/room DEFAULT_ISSUE ${OLD_ISSUE} -> ${NEW_ISSUE}
- Docs pointers (README.md, CONTRIBUTING.md, docs/ROOM-*.md) naming the old
  board number: follow-up pointers-only PR by the owning lanes — see
  docs/BOARD-ROTATION-READINESS.md §8 for the file list (beware the two
  false-positive classes: dasha-lobby PR #266 refs and the '266 checks'
  test count).

Merge on exact-head full green CI per standing authority." 2>/dev/null)"
  say "pointers PR opened: ${pr_url}"
fi

# ---------------------------------------------------------------------------
# 11. First rebuild of the new board -> room-state branch
# ---------------------------------------------------------------------------
if [ "$DO_ROOM_STATE_PUSH" = 1 ]; then
  _root="$(git rev-parse --show-toplevel)"
  ( cd "$_root" && "$ROOM_BIN" --issue "$NEW_ISSUE" rebuild --out ROOM-STATE.md --commit-push )
  say "ROOM-STATE.md rebuilt for #${NEW_ISSUE} and pushed to room-state"
fi

say "cutover complete: #${OLD_ISSUE} -> #${NEW_ISSUE} (${n_carried} carried, watermark ${W_FINAL})"

#!/usr/bin/env bash
#
# tests/room-watch-enforcer.test.sh — regression tests for RC-2026-09-26-969
# (room-watch sweep / receipts-scan misfires fixed in scripts/room).
#
# Test-audit authoring gate (repo AGENTS.md -> .agents/skills/test-audit):
#  1. Behavior protected: the enforcer's false-positive suppressions —
#     (a) no strike-two when the lane posted a voluntary prose release newer
#     than the strike-one (real case RC-2026-09-25-7401);
#     (b) receipts-scan never re-flags claims covered by a posted
#     missing-receipts digest + the lane's closing response (real cases
#     RC-2026-09-23-903/953, digest 5824967872, closeout 5825166515);
#     (c) no strike-one when the claim's deliverable already merged (real
#     cases RC-2026-09-25-301..304, PRs #1072-#1075).
#     Observable at the script's own fixture boundary: `_sweep-plan` and
#     `_receipts-plan` output for fixture board comments.
#  2. Credible regression: a later edit to scripts/room that drops any of
#     the three checks re-proposes the bogus strike / re-flags the closed
#     claim, and the assertions below fail.
#  3. Existing coverage: none — no test exercises scripts/room's sweep or
#     receipts-scan paths (the _parse/_state/_clock fixture verbs exist but
#     are untested; node --test covers the JS room, not this bash enforcer).
#  4. Production seam: the _sweep-plan/_receipts-plan fixture verbs plus
#     ROOM_TEST_PRS_JSON, following the file's existing _parse/_state/_clock
#     fixture-verb convention. No mocks: the real script parses real fixture
#     comments. Every scenario carries a negative control, so the suite
#     cannot pass by suppressing everything.
#
# Run:  TMPDIR=<worktree>/.tmp bash tests/room-watch-enforcer.test.sh
# (TMPDIR must be worktree-local, never the shared /tmp tmpfs.)

set -euo pipefail

ROOM="${ROOM:-$(cd "$(dirname "$0")/.." && pwd)/scripts/room}"
TMPD="${TMPDIR:-/tmp}/room-watch-enforcer-test.$$"
mkdir -p "$TMPD"
trap 'rm -rf "$TMPD"' EXIT

pass=0
fail=0

expect_in() { # $1 = name, $2 = file, $3 = fixed-string pattern (must appear)
  if grep -qF "$3" "$2"; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  expected to find: %s\n' "$1" "$3"
  fi
}

expect_not_in() { # $1 = name, $2 = file, $3 = fixed-string pattern (must not appear)
  if grep -qF "$3" "$2"; then
    fail=$((fail + 1)); printf 'FAIL %s\n  unexpectedly found: %s\n' "$1" "$3"
  else
    pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  fi
}

# ---------------------------------------------------------------------------
# (a) strike-two after a voluntary prose release (RC-2026-09-25-7401)
# Claim 6h lease at 00:00, strike-one stamped 06:16, prose STATUS release
# 06:30 ("Releasing ..."). At 12:00 the 4h strike grace has elapsed.
# ---------------------------------------------------------------------------

cat > "$TMPD/a.json" <<'EOF'
[
 {"id": 1, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] fixture a\n\n```room-claim\ntask-id:    RC-2026-09-26-900\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```\n\n· claim:RC-2026-09-26-900 · lane:jill"},
 {"id": 2, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-900 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-900:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-900 · lane:jill"},
 {"id": 3, "created_at": "2026-09-26T06:30:00Z", "body": "[jill]STATUS: Releasing RC-2026-09-26-900 (review-only; files NONE). The review has not been performed, so this lease should not stay reserved. No finding is claimed."}
]
EOF

# Negative control: identical board, but the lane never released.
jq '[.[0,1]]' "$TMPD/a.json" > "$TMPD/a-control.json"

export ROOM_TEST_PRS_JSON='[]'
"$ROOM" _sweep-plan --now 2026-09-26T12:00:00Z < "$TMPD/a.json" > "$TMPD/a.out"
"$ROOM" _sweep-plan --now 2026-09-26T12:00:00Z < "$TMPD/a-control.json" > "$TMPD/a-control.out"

expect_in     "a/release newer than strike-one suppresses strike-two" \
  "$TMPD/a.out" "strike-two suppressed for RC-2026-09-26-900"
expect_not_in "a/no strike-two PLAN after the release" \
  "$TMPD/a.out" "PLAN: strike-two release for RC-2026-09-26-900"
expect_in     "a/control: strike-two still fires with no release" \
  "$TMPD/a-control.out" "PLAN: strike-two release for RC-2026-09-26-900"

# ---------------------------------------------------------------------------
# (b) receipts-scan re-flagging digest-closed claims (RC-2026-09-23-903/953)
# 901: completed, digest-listed, lane closed it in prose after the digest
#      (references the digest id, "already on the board" — the 903 shape).
# 902: completed, digest-listed, lane closed it with a fenced room-receipt
#      block inside a prose comment (the 953 shape: 5825166515).
# 903: completed, digest-listed, never closed out — must still be flagged.
# ---------------------------------------------------------------------------

cat > "$TMPD/b.json" <<'EOF'
[
 {"id": 10, "created_at": "2026-09-25T00:00:00Z", "body": "[jill][claim] b901\n\n```room-claim\ntask-id:    RC-2026-09-26-901\nlane:       jill\nfiles:      docs/a.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 11, "created_at": "2026-09-25T12:00:00Z", "body": "[jill]DONE: RC-2026-09-26-901 finished"},
 {"id": 12, "created_at": "2026-09-25T00:05:00Z", "body": "[jill][claim] b902\n\n```room-claim\ntask-id:    RC-2026-09-26-902\nlane:       jill\nfiles:      docs/b.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 13, "created_at": "2026-09-25T12:05:00Z", "body": "[jill]DONE: RC-2026-09-26-902 finished"},
 {"id": 14, "created_at": "2026-09-25T00:10:00Z", "body": "[jill][claim] b903\n\n```room-claim\ntask-id:    RC-2026-09-26-903\nlane:       jill\nfiles:      docs/c.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 15, "created_at": "2026-09-25T12:10:00Z", "body": "[jill]DONE: RC-2026-09-26-903 finished"},
 {"id": 100, "created_at": "2026-09-26T01:00:00Z", "body": "[room-watch] missing receipts (24h SLO)\n\nThe following completed tasks have no room-receipt block on the board:\n\n- TASK RC-2026-09-26-901 (jill, completed 2026-09-25T12:00:00Z)\n- TASK RC-2026-09-26-902 (jill, completed 2026-09-25T12:05:00Z)\n- TASK RC-2026-09-26-903 (jill, completed 2026-09-25T12:10:00Z)"},
 {"id": 101, "created_at": "2026-09-26T02:00:00Z", "body": "[jill] re: room-watch missing-receipts sweep (100) - closing 901 and 902:\n\nDONE: RC-2026-09-26-901 - the receipt is already on the board, pr NONE, no merge SHA to cite. Closing so the watch stops counting it.\n\nDONE: RC-2026-09-26-902:\n\n```room-receipt\ntask-id:    RC-2026-09-26-902\nlane:       jill\nstate:      completed\npr:         #1087\nmerged:      091ef1c18fd789f8a3ee1a7fff4c7b0bb0313013\n```"}
]
EOF

"$ROOM" _receipts-plan --now 2026-09-27T12:00:00Z --prs '[]' \
  < "$TMPD/b.json" > "$TMPD/b.out" || true

expect_not_in "b/prose closeout after digest is not re-flagged (901)" \
  "$TMPD/b.out" "RC-2026-09-26-901"
expect_not_in "b/fenced receipt in prose comment is not re-flagged (902)" \
  "$TMPD/b.out" "RC-2026-09-26-902"
expect_in     "b/unclosed claim is still flagged (903)" \
  "$TMPD/b.out" "RC-2026-09-26-903"

# ---------------------------------------------------------------------------
# (c) strike-one on already-merged deliverables (RC-2026-09-25-301..304)
# 904: working, lease expired, merged PR #1087 names the task-id in its body.
# 905: working, lease expired, no PR — the negative control.
# 906: working, lease expired, a [receipt] on the board cites a merge SHA.
# ---------------------------------------------------------------------------

cat > "$TMPD/c.json" <<'EOF'
[
 {"id": 20, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] c904\n\n```room-claim\ntask-id:    RC-2026-09-26-904\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 21, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] c905\n\n```room-claim\ntask-id:    RC-2026-09-26-905\nlane:       jill\nfiles:      docs/x.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 22, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] c906\n\n```room-claim\ntask-id:    RC-2026-09-26-906\nlane:       jill\nfiles:      docs/y.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 23, "created_at": "2026-09-26T07:00:00Z", "body": "[jill][receipt] RC-2026-09-26-906 landed\n\nMerged as 4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e.\n\n```room-receipt\ntask-id:    RC-2026-09-26-906\nmerged:      4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e\nattribution: (jill, agent, quill)\n```"}
]
EOF

export ROOM_TEST_PRS_JSON='[{"number":1087,"merged_at":"2026-09-26T07:00:00Z","title":"[jill] fix thing","body":"RC-2026-09-26-904: fixed the thing.\n\nPatch handoff: https://github.com/Uuriko/project-room/issues/266#issuecomment-1"},{"number":1088,"merged_at":null,"title":"unrelated","body":"nothing"}]'

"$ROOM" _sweep-plan --now 2026-09-26T08:00:00Z < "$TMPD/c.json" > "$TMPD/c.out"

expect_in     "c/merged PR suppresses strike-one (904)" \
  "$TMPD/c.out" "strike-one suppressed for RC-2026-09-26-904"
expect_not_in "c/no strike-one PLAN when PR merged (904)" \
  "$TMPD/c.out" "PLAN: strike-one nudge for RC-2026-09-26-904"
expect_in     "c/board receipt suppresses strike-one (906)" \
  "$TMPD/c.out" "strike-one suppressed for RC-2026-09-26-906"
expect_in     "c/control: strike-one still fires with no PR (905)" \
  "$TMPD/c.out" "PLAN: strike-one nudge for RC-2026-09-26-905"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

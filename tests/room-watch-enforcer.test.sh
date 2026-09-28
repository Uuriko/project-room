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
#     Companion false-positive cases (RC-2026-09-26-1130) guard the bypasses
#     the (a)/(b)/(c) checks introduced: progress prose must not read as a
#     voluntary release ("closing in on the fix"), promise language must not
#     close a receipts digest ("closing in on the receipt"), and a mere PR
#     mention must not count as a landed deliverable (subject-line form
#     `RC-<id>:` required). Each fails on the pre-1130 regexes and passes
#     after the tightening.
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

expect_jq() { # $1 = name, $2 = state JSON file, $3 = jq filter (must output true)
  if jq -e "$3" "$2" >/dev/null; then
    pass=$((pass + 1)); printf 'ok   %s\n' "$1"
  else
    fail=$((fail + 1)); printf 'FAIL %s\n  jq filter false: %s\n' "$1" "$3"
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
# (a2) weasel-worded progress prose must NOT read as a voluntary release
# Same board shape as (a), but the lane's STATUS says "closing in on the
# fix ... Not giving up this claim." The release regex must not fire on
# "closing", so strike-two must still be planned.
# ---------------------------------------------------------------------------

cat > "$TMPD/a2.json" <<'EOF'
[
 {"id": 1, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] fixture a2\n\n```room-claim\ntask-id:    RC-2026-09-26-907\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```\n\n· claim:RC-2026-09-26-907 · lane:jill"},
 {"id": 2, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-907 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-907:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-907 · lane:jill"},
 {"id": 3, "created_at": "2026-09-26T06:30:00Z", "body": "[jill]STATUS: still in progress on RC-2026-09-26-907 — closing in on the fix, need a few more hours. Not giving up this claim."}
]
EOF

export ROOM_TEST_PRS_JSON='[]'
"$ROOM" _sweep-plan --now 2026-09-26T12:00:00Z < "$TMPD/a2.json" > "$TMPD/a2.out"

expect_in     "a2/progress prose is not a release: strike-two fires" \
  "$TMPD/a2.out" "PLAN: strike-two release for RC-2026-09-26-907"
expect_not_in "a2/no voluntary-release suppression on weasel prose" \
  "$TMPD/a2.out" "strike-two suppressed for RC-2026-09-26-907"

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
# (b2) promise language must NOT close a receipts digest
# 908: completed, digest-listed, then the lane posts a weasel promise after
# the digest ("still closing in on the receipt ... not closing this out
# yet" — deliberately NOT referencing the digest id and carrying no
# room-receipt fence). It must still be flagged.
# ---------------------------------------------------------------------------

cat > "$TMPD/b2.json" <<'EOF'
[
 {"id": 16, "created_at": "2026-09-25T00:15:00Z", "body": "[jill][claim] b908\n\n```room-claim\ntask-id:    RC-2026-09-26-908\nlane:       jill\nfiles:      docs/d.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 17, "created_at": "2026-09-25T12:15:00Z", "body": "[jill]DONE: RC-2026-09-26-908 finished"},
 {"id": 200, "created_at": "2026-09-26T01:00:00Z", "body": "[room-watch] missing receipts (24h SLO)\n\nThe following completed tasks have no room-receipt block on the board:\n\n- TASK RC-2026-09-26-908 (jill, completed 2026-09-25T12:15:00Z)"},
 {"id": 201, "created_at": "2026-09-26T03:00:00Z", "body": "[jill] still closing in on the receipt for RC-2026-09-26-908 — will post it tomorrow. Not closing this out yet."}
]
EOF

"$ROOM" _receipts-plan --now 2026-09-27T12:00:00Z --prs '[]' \
  < "$TMPD/b2.json" > "$TMPD/b2.out" || true

expect_in     "b2/promise language does not close the digest (908 flagged)" \
  "$TMPD/b2.out" "RC-2026-09-26-908"

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

export ROOM_TEST_PRS_JSON='[{"number":1087,"merged_at":"2026-09-26T07:00:00Z","title":"[jill] fix thing","body":"RC-2026-09-26-904: fixed the thing.\n\nPatch handoff: https://github.com/Uuriko/project-room/issues/266#issuecomment-1"},{"number":1088,"merged_at":null,"title":"unrelated","body":"nothing"},{"number":1090,"merged_at":"2026-09-26T07:30:00Z","merge_commit_sha":"4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c2d3e","title":"[jill] c906 work","body":"RC-2026-09-26-906: done."}]'

"$ROOM" _sweep-plan --now 2026-09-26T08:00:00Z < "$TMPD/c.json" > "$TMPD/c.out"

expect_in     "c/merged PR suppresses strike-one (904)" \
  "$TMPD/c.out" "strike-one suppressed for RC-2026-09-26-904"
expect_not_in "c/no strike-one PLAN when PR merged (904)" \
  "$TMPD/c.out" "PLAN: strike-one nudge for RC-2026-09-26-904"
expect_in     "c/board receipt suppresses strike-one (906)" \
  "$TMPD/c.out" "strike-one suppressed for RC-2026-09-26-906"
expect_in     "c/control: strike-one still fires with no PR (905)" \
  "$TMPD/c.out" "PLAN: strike-one nudge for RC-2026-09-26-905"

# ---------------------------------------------------------------------------
# (c2) a mere PR mention must NOT count as a landed deliverable
# 909: working, lease expired, merged PR #1089 mentions the task-id
# mid-sentence ("touches the same area as RC-... but does not implement
# it") without the subject-line form. Strike-one must still fire.
# ---------------------------------------------------------------------------

cat > "$TMPD/c2.json" <<'EOF'
[
 {"id": 24, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] c909\n\n```room-claim\ntask-id:    RC-2026-09-26-909\nlane:       jill\nfiles:      docs/z.md\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"}
]
EOF

export ROOM_TEST_PRS_JSON='[{"number":1089,"merged_at":"2026-09-26T07:00:00Z","title":"[jill] drive-by area touch","body":"Drive-by note: this touches the same area as RC-2026-09-26-909 but does not implement it."}]'

"$ROOM" _sweep-plan --now 2026-09-26T08:00:00Z < "$TMPD/c2.json" > "$TMPD/c2.out"

expect_in     "c2/drive-by PR mention does not suppress strike-one (909)" \
  "$TMPD/c2.out" "PLAN: strike-one nudge for RC-2026-09-26-909"
expect_not_in "c2/no deliverable-landed suppression on mere mention" \
  "$TMPD/c2.out" "strike-one suppressed for RC-2026-09-26-909"

# ---------------------------------------------------------------------------
# (d) the post-strike release grace is BOUNDED to 24h (deep audit 5850225536)
# Claim 6h lease at 00:00, strike-one 06:16, prose release 06:30.
# At 2026-09-27T05:00Z (22.5h after release) strike-two stays suppressed;
# at 2026-09-27T08:00Z (25.5h after release) the plan fires again.
# ---------------------------------------------------------------------------

cat > "$TMPD/d.json" <<'EOF'
[
 {"id": 30, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] d\n\n```room-claim\ntask-id:    RC-2026-09-26-910\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 31, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-910 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-910:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-910 · lane:jill"},
 {"id": 32, "created_at": "2026-09-26T06:30:00Z", "body": "[jill]STATUS: Releasing RC-2026-09-26-910 (review-only; files NONE). The review has not been performed, so this lease should not stay reserved."}
]
EOF

export ROOM_TEST_PRS_JSON='[]'
"$ROOM" _sweep-plan --now 2026-09-27T05:00:00Z < "$TMPD/d.json" > "$TMPD/d-inside.out"
"$ROOM" _sweep-plan --now 2026-09-27T08:00:00Z < "$TMPD/d.json" > "$TMPD/d-after.out"

expect_in     "d/release grace still suppresses inside 24h (910)" \
  "$TMPD/d-inside.out" "strike-two suppressed for RC-2026-09-26-910"
expect_not_in "d/no strike-two PLAN inside the grace window" \
  "$TMPD/d-inside.out" "PLAN: strike-two release for RC-2026-09-26-910"
expect_in     "d/strike-two fires again after the 24h grace (910)" \
  "$TMPD/d-after.out" "PLAN: strike-two release for RC-2026-09-26-910"

# ---------------------------------------------------------------------------
# (e) F3 reducer: exact +4h boundary and 24h release grace (5850228747)
# 911: strike-one 06:16, forged strike-two stamped at exactly +14400s —
#      ignored (grace boundary is <=, sweep only posts past 14400s).
# 912: strike-one 06:16, release 06:30, forged strike-two 12:00 (inside the
#      24h grace) — ignored. 913: same shape, forged strike-two at
#      2026-09-27T08:00Z (after the grace) — honored, claim released.
# Observed at the _state boundary: task state + reducer log lines.
# ---------------------------------------------------------------------------

cat > "$TMPD/e.json" <<'EOF'
[
 {"id": 40, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] e911\n\n```room-claim\ntask-id:    RC-2026-09-26-911\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 41, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-911 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-911:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-911 · lane:jill"},
 {"id": 42, "created_at": "2026-09-26T10:16:00Z", "body": "[quill-s2]RECLAIM (strike 2): @jill - no heartbeat 4h after strike-one. (quill-s2, scheduled, quill)\n\n<!-- room:strike-two:RC-2026-09-26-911:2026-09-26T10:16:00Z -->\n\n· claim:RC-2026-09-26-911 · lane:jill"},
 {"id": 43, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] e912\n\n```room-claim\ntask-id:    RC-2026-09-26-912\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 44, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-912 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-912:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-912 · lane:jill"},
 {"id": 45, "created_at": "2026-09-26T06:30:00Z", "body": "[jill]STATUS: Releasing RC-2026-09-26-912 (review-only; files NONE)."},
 {"id": 46, "created_at": "2026-09-26T12:00:00Z", "body": "[quill-s2]RECLAIM (strike 2): @jill - no heartbeat 4h after strike-one. (quill-s2, scheduled, quill)\n\n<!-- room:strike-two:RC-2026-09-26-912:2026-09-26T12:00:00Z -->\n\n· claim:RC-2026-09-26-912 · lane:jill"},
 {"id": 47, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] e913\n\n```room-claim\ntask-id:    RC-2026-09-26-913\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 48, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-913 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-913:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-913 · lane:jill"},
 {"id": 49, "created_at": "2026-09-26T06:30:00Z", "body": "[jill]STATUS: Releasing RC-2026-09-26-913 (review-only; files NONE)."},
 {"id": 50, "created_at": "2026-09-27T08:00:00Z", "body": "[quill-s2]RECLAIM (strike 2): @jill - no heartbeat 4h after strike-one. (quill-s2, scheduled, quill)\n\n<!-- room:strike-two:RC-2026-09-26-913:2026-09-27T08:00:00Z -->\n\n· claim:RC-2026-09-26-913 · lane:jill"}
]
EOF

"$ROOM" _parse < "$TMPD/e.json" | "$ROOM" _state --now 2026-09-27T09:00:00Z > "$TMPD/e.state"

expect_in     "e/exact +14400s forged strike-two ignored (911)" \
  "$TMPD/e.state" "strike-two before the 4h strike grace elapsed"
expect_jq     "e/911 not released by the boundary stamp" \
  "$TMPD/e.state" '.tasks | map(select(.task_id=="RC-2026-09-26-911"))[0].state != "submitted"'
expect_in     "e/forged strike-two inside 24h release grace ignored (912)" \
  "$TMPD/e.state" "inside the 24h voluntary-release grace"
expect_jq     "e/forged strike-two after the grace honored (913 released)" \
  "$TMPD/e.state" '.tasks | map(select(.task_id=="RC-2026-09-26-913"))[0].state == "submitted"'

# ---------------------------------------------------------------------------
# (f) premature pre-expiry strike-one stamps are ignored (5850230537)
# 914: 6h lease from 00:00 (expires 06:00), forged strike-one at 01:00 —
#      ignored, strike_one_at stays null. 915: same lease, strike-one at
#      06:16 — recorded.
# ---------------------------------------------------------------------------

cat > "$TMPD/f.json" <<'EOF'
[
 {"id": 60, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] f914\n\n```room-claim\ntask-id:    RC-2026-09-26-914\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 61, "created_at": "2026-09-26T01:00:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-914 expired 5h ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-914:2026-09-26T01:00:00Z -->\n\n· claim:RC-2026-09-26-914 · lane:jill"},
 {"id": 62, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] f915\n\n```room-claim\ntask-id:    RC-2026-09-26-915\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 63, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-915 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-915:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-915 · lane:jill"}
]
EOF

"$ROOM" _parse < "$TMPD/f.json" | "$ROOM" _state --now 2026-09-26T08:00:00Z > "$TMPD/f.state"

expect_in     "f/premature strike-one ignored (914)" \
  "$TMPD/f.state" "strike-one before lease expiry: ignored (premature stamp"
expect_jq     "f/914 strike_one_at stays null" \
  "$TMPD/f.state" '.tasks | map(select(.task_id=="RC-2026-09-26-914"))[0].strike_one_at == null'
expect_jq     "f/control: post-expiry strike-one recorded (915)" \
  "$TMPD/f.state" '.tasks | map(select(.task_id=="RC-2026-09-26-915"))[0].strike_one_at == "2026-09-26T06:16:00Z"'

# ---------------------------------------------------------------------------
# (g) strike stamps in EDITED comments are ignored (5850231451)
# 916: strike-one comment edited after posting (updated_at > created_at) —
#      ignored. 917: identical but unedited — recorded.
# ---------------------------------------------------------------------------

cat > "$TMPD/g.json" <<'EOF'
[
 {"id": 70, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] g916\n\n```room-claim\ntask-id:    RC-2026-09-26-916\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 71, "created_at": "2026-09-26T06:16:00Z", "updated_at": "2026-09-26T07:00:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-916 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-916:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-916 · lane:jill"},
 {"id": 72, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] g917\n\n```room-claim\ntask-id:    RC-2026-09-26-917\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 73, "created_at": "2026-09-26T06:16:00Z", "body": "[quill-s2]RECLAIM (strike 1): @jill - lease on RC-2026-09-26-917 expired 16m ago, no heartbeat seen. (quill-s2, scheduled, quill)\n\n<!-- room:strike-one:RC-2026-09-26-917:2026-09-26T06:16:00Z -->\n\n· claim:RC-2026-09-26-917 · lane:jill"}
]
EOF

"$ROOM" _parse < "$TMPD/g.json" | "$ROOM" _state --now 2026-09-26T08:00:00Z > "$TMPD/g.state"

expect_in     "g/edited strike-one ignored (916)" \
  "$TMPD/g.state" "strike-one in an edited comment"
expect_jq     "g/916 strike_one_at stays null" \
  "$TMPD/g.state" '.tasks | map(select(.task_id=="RC-2026-09-26-916"))[0].strike_one_at == null'
expect_jq     "g/control: unedited strike-one recorded (917)" \
  "$TMPD/g.state" '.tasks | map(select(.task_id=="RC-2026-09-26-917"))[0].strike_one_at == "2026-09-26T06:16:00Z"'

# ---------------------------------------------------------------------------
# (h) a bare [done] appends no receipt: missing_receipt stays true (5850232752)
# 918: [done] with no receipt fence — completed, receipts empty,
#      flagged by receipts-scan. 919: [done] WITH a receipt fence — not flagged.
# ---------------------------------------------------------------------------

cat > "$TMPD/h.json" <<'EOF'
[
 {"id": 80, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] h918\n\n```room-claim\ntask-id:    RC-2026-09-26-918\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 81, "created_at": "2026-09-26T01:00:00Z", "body": "[jill][done] RC-2026-09-26-918 done, no receipt fence here."},
 {"id": 82, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] h919\n\n```room-claim\ntask-id:    RC-2026-09-26-919\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 83, "created_at": "2026-09-26T01:00:00Z", "body": "[jill][done] RC-2026-09-26-919 landed\n\n```room-done\ntask-id: RC-2026-09-26-919\npr: 1091\nmerged: a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4\n```"}
]
EOF

"$ROOM" _parse < "$TMPD/h.json" | "$ROOM" _state --now 2026-09-26T08:00:00Z > "$TMPD/h.state"

expect_jq     "h/bare done completes the claim (918)" \
  "$TMPD/h.state" '.tasks | map(select(.task_id=="RC-2026-09-26-918"))[0].state == "completed"'
expect_jq     "h/bare done keeps missing_receipt true (918)" \
  "$TMPD/h.state" '.tasks | map(select(.task_id=="RC-2026-09-26-918"))[0].missing_receipt == true'
expect_jq     "h/control: fenced done records the receipt (919)" \
  "$TMPD/h.state" '.tasks | map(select(.task_id=="RC-2026-09-26-919"))[0].receipts[0].merged == "a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4"'

export ROOM_TEST_PRS_JSON='[]'
"$ROOM" _receipts-plan --now 2026-09-28T00:00:00Z < "$TMPD/h.json" > "$TMPD/h.out" || true

expect_in     "h/receipts-scan flags the bare done (918)" \
  "$TMPD/h.out" "RC-2026-09-26-918"
expect_not_in "h/receipts-scan does not flag the fenced done (919)" \
  "$TMPD/h.out" "RC-2026-09-26-919"

# ---------------------------------------------------------------------------
# (i) forged prose receipts no longer suppress strike-one (5850227334)
# 920: expired claim + prose receipt with a fabricated SHA, no real PR —
#      strike-one fires. 921: same shape, but the SHA prefixes a real
#      merged PR's merge_commit_sha — suppressed.
# ---------------------------------------------------------------------------

cat > "$TMPD/i.json" <<'EOF'
[
 {"id": 90, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] i920\n\n```room-claim\ntask-id:    RC-2026-09-26-920\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 91, "created_at": "2026-09-26T07:00:00Z", "body": "[jill][receipt] RC-2026-09-26-920 landed\n\nMerged as deadbeefdeadbeefdeadbeefdeadbeefdeadbeef.\n\n```room-receipt\ntask-id:    RC-2026-09-26-920\nmerged:      deadbeefdeadbeefdeadbeefdeadbeefdeadbeef\nattribution: (jill, agent, quill)\n```"},
 {"id": 92, "created_at": "2026-09-26T00:00:00Z", "body": "[jill][claim] i921\n\n```room-claim\ntask-id:    RC-2026-09-26-921\nlane:       jill\nfiles:      scripts/room\nlease:      lease=6h\nstate:      working\nreason:     fixture\n```"},
 {"id": 93, "created_at": "2026-09-26T07:00:00Z", "body": "[jill][receipt] RC-2026-09-26-921 landed\n\nMerged as b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5.\n\n```room-receipt\ntask-id:    RC-2026-09-26-921\nmerged:      b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5\nattribution: (jill, agent, quill)\n```"}
]
EOF

export ROOM_TEST_PRS_JSON='[{"number":1091,"merged_at":"2026-09-26T07:30:00Z","merge_commit_sha":"b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f6a7","title":"[jill] i921 work","body":"RC-2026-09-26-921: done."}]'

"$ROOM" _sweep-plan --now 2026-09-26T08:00:00Z < "$TMPD/i.json" > "$TMPD/i.out"

expect_in     "i/fabricated receipt does not suppress strike-one (920)" \
  "$TMPD/i.out" "PLAN: strike-one nudge for RC-2026-09-26-920"
expect_not_in "i/no deliverable-landed suppression on a forged SHA (920)" \
  "$TMPD/i.out" "strike-one suppressed for RC-2026-09-26-920"
expect_in     "i/SHA-anchored receipt still suppresses strike-one (921)" \
  "$TMPD/i.out" "strike-one suppressed for RC-2026-09-26-921"

printf '\n%d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ]

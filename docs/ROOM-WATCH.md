<!--
  Adapted from rowboatlabs/rowboat (https://github.com/rowboatlabs/rowboat),
  © rowboatlabs, licensed under the Apache License 2.0
  (https://www.apache.org/licenses/LICENSE-2.0).

  Scheduler discipline adapted here: atomic temp+rename state writes,
  a slow tick, retry-then-surface, the config/state split, and grace
  windows around every automated action. Ported to the substrate:
  GitHub issue comments, not websockets.
-->

# ROOM-WATCH.md

The decay enforcer for the claims board (`Uuriko/project-room` issue #266).

## 1. What the watcher is

The watcher is the decay enforcer between the machine plane
(`ROOM-STATE.md`) and the human plane (the periodic digest). It is a cron
job, not a lane: it holds no claims, negotiates nothing, and takes no
sides. Its contract is simple:

- **Every claim gets a TTL.** Leases expire; heartbeats renew them.
- **Expired work is reclaimed, never silently closed.** A task that
  mattered stays open under a new task-id; a task nobody re-claims was
  never important (protocol §4, §13).
- **Duplicate claims are refused and recorded, never silent.** No
  overwrite, no "I didn't see your claim."

Stigmergy in one line: **the issue thread is the environment, status
lines are pheromone deposits, the cron is evaporation.** Agents leave
fenced blocks as deposits; the watcher's tick evaporates the stale ones
by the book.

## 2. Tick jobs

Each tick runs the `scripts/room` enforcer verbs in this order:

1. `rebuild --out ROOM-STATE.md --commit-push` — regenerate the machine
   board from #266 via gh REST, push to the `room-state` automation
   branch (never main).
2. `sweep [--dry-run]` — strike-one nudge @-mentioning the holding lane
   (4h grace), then strike-two release back to `submitted`; reject
   illegal transitions.
3. `receipts-scan [--post]` — flag tasks past the 24h receipt SLO.
4. `rotation-check` — compare board comment count against the 1500
   threshold.
5. `metrics [--since]` — claims opened/completed/expired, receipts,
   missing receipts, distinct lanes, comments/day.

Order is load-bearing: **rebuild runs first so the sweep works off fresh
structured state.** The protocol's rule applies here too — stamp at
write, never reconstruct from prose.

## 3. Watermark discipline

- Read comment ids from **REST numeric ids on #266 ONLY**:
  `gh api repos/Uuriko/project-room/issues/266/comments --paginate`.
  Compare `id > watermark`.
- **Never use `gh issue view --json comments`** for the board — it
  exposes no numeric ids, so watermarks cannot be compared against it.
- Watermark file:
  `~/workspace/goals/agent-swarm-coordination/hidden_files/room-watch-watermark.txt`.
  Update atomically: write temp file, then rename.

## 4. Slow tick

- Interval: **30 minutes.**
- Catch-up rule after outages: **process everything since the
  watermark, never skip.** A missed tick is not a lost tick — the REST
  scan replays the full backlog. Nothing is dropped to "catch up."

## 5. Retry-then-surface

- Enforcer verbs run with `--dry-run` first. The worker inspects the
  plan; only then the live run.
- On repeated failure of a verb, **post nothing new.** Do not retry
  blindly. Surface the failure to John in the digest with the verb, the
  error, and the last good watermark — then wait for his call.

## 6. Config/state split

- **Config** = the cron job's instructions (the `swarm-room-watch` body).
  It lives with the scheduler definition.
- **State** = the watermark file and run logs. They live in
  `~/workspace/goals/agent-swarm-coordination/hidden_files/` —
  **never in the repo.**
- The repo carries only derived, machine-generated state
  (`ROOM-STATE.md` on the `room-state` branch); the watcher never edits
  the working tree.

## 7. Grace windows

- Strike-one RECLAIM nudge → **4h** for a heartbeat → strike-two
  RECLAIM releases the claim back to `submitted` (protocol §4).
- Receipt SLO: **24h** after a merge lands; missing receipts get one
  digest comment, not repeated nagging.
- Rotation trigger: **1500 board comments.** When the count crosses it,
  the board must rotate to a fresh issue. Full runbook in **§8** —
  trigger, hand-off, close-not-delete, cross-linking, post-rotation.

## 8. Board rotation runbook

Fail-closed throughout: the rotation is prepared by the worker, never
by the cron, and never on a stale or projected count. If the board is
at or under 1500 comments, this section does not execute — record the
count and stand down.

### 8.1 Trigger

1. `rotation-check` compares the live #266 comment count against the
   1500 threshold and reports `rotation_due=yes` only when the count is
   **strictly above 1500**.
2. `rotation_due=yes` is a signal, not an order. Before any rotation
   step, re-confirm the count a second time against the live REST API:
   `gh api repos/Uuriko/project-room/issues/266/comments --paginate`
   (numeric ids only — never `gh issue view --json comments`).
3. A human (John, or the on-duty worker with his standing direction)
   confirms the decision in the digest or on the board. No confirmation,
   no rotation.
4. If the count is at or under 1500: **stand down.** Record the measured
   count; do not open the new issue, do not post the hand-off.

### 8.2 Summary hand-off format

Before the new issue takes over, post exactly one fenced summary on
the old issue, so the new board starts from recorded state instead of
reconstructed prose:

```text
[room-watch][rotation-handoff]
old issue:    #266
new issue:    #<N>              (filled once created)
watermark:    <last processed numeric comment id on #266>
open claims:  <task-id> lane=<lane> lease=<state/expiry>   (one line each)
unclaimed lanes: <comma-separated lanes with no open claim>
missing receipts: <task-id> merged, receipt not posted    (one line each)
machine board: <link to the last ROOM-STATE.md commit on the room-state branch>
```

One comment, no @-mentions except lanes whose claims must re-claim on
the new board. This is a protocol-mechanical `[room-watch]` post,
allowed under §9.

### 8.3 Close, never delete

1. The old issue is **NEVER deleted.** It stays open as a read-only
   archive of the board's history.
2. Post the hand-off comment (§8.2) plus a closing note: the board has
   moved, and no further claims, receipts, or status lines are accepted
   on the old issue.
3. Open the new issue titled exactly: `Claims board (continued from #N)`
   — the same lineage convention as `#11 → #266`.
4. Any claim posted to the old issue after rotation is refused by
   protocol and pointed at the new issue (duplicate-claim refusal
   record, §9).

### 8.4 Cross-linking

1. Post a bidirectional link pair: a comment on the old issue naming
   the new issue, and the new issue's body (or its first comment)
   naming the old issue.
2. Update any README/docs pointers that name the old issue number via a
   small PR — pointers only, no other changes in that diff.
3. Record the linkage in the watermark file's rotation log line so the
   cron's config/state split (§6) survives the move.

### 8.5 Post-rotation

1. **Watermark reset.** Append `rotation: #266 -> #N, final watermark
   <id>` to the watermark file, then set the active watermark to the
   new issue's opening comment id. Atomic temp+rename, same as §3.
2. **First rebuild.** Run `rebuild` against the new issue, push the
   resulting `ROOM-STATE.md` to the `room-state` branch, and verify the
   new board renders before any lane claims on it.
3. **Config update.** Point the cron job's instructions at the new issue
   number. Config lives with the scheduler definition; the watermark
   file is state — update them separately, never by editing one to
   stand in for the other.

## 9. What the watcher may post

Protocol-mechanical only. Posts go out under John's account with the
lane tag **`[room-watch]`**, always with the room-claim/room-receipt
fenced grammar and `(room-watch, scheduled, quill)` attribution. Allowed:

- RECLAIM strike-one / strike-two comments (protocol §4).
- Duplicate-claim refusal records and illegal-transition rejections.
- The missing-receipts digest comment.
- Machine-board commits on the `room-state` branch (via
  `rebuild --commit-push`; never main, never force-push).

Everything else is read-only: no prose opinions, no negotiations, no
negotiation nudges, no DMs to anyone. Noise discipline (§11): never
post play-by-play — routine state goes to ROOM-STATE.md, words that
aren't claims/handoffs/receipts go to the digest, and the digest gets
no @-mentions except for items needing John's call.

## 10. Current status

The `swarm-room-watch` cron (`interval@30m`) has been **PAUSED since
2026-09-14** (`enabled: false`). This wave lands the enforcer verbs
(`scripts/room`) and this doc. Re-enabling is **John's call** — the PR
proposes it, it does not do it.

## 11. Failure modes

- **Board passes 1500 comments while paused.** Nothing enforced; leases
  drift, duplicates may collide silently. The rotation runbook is now in
  §8 — re-enabling the watcher before re-checking the count is still
  John's call, recorded as accepted risk.
- **`gh` rate-limits.** Stop. Do not sleep-retry in a cron run; the
  next tick is 30 minutes away. Surface the limit in the digest and
  record the last good watermark so the next run replays from it.
- **A RECLAIM post 403s** (e.g. issue locked like #11 was). The action
  is recorded in the digest and the watermark file notes the failed
  comment id so it is not retried into a loop; the worker does not post
  alternative notices elsewhere.

---

*Ported 2026-09-16 (quill-s2, Wave 2): decay-enforcer spec for the
#266 claims board. Rotation runbook landed in Wave 3, §8.*

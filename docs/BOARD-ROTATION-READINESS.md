# Board Rotation Readiness — Uuriko/project-room#266

**Status:** preparation only. The rotation itself is NOT executed by this
package. Nothing here posts to #266, creates the successor issue, or alters
live state, except the single repo-file claim already registered for this work.

**Package contents:**

- `scripts/rotation-cutover.sh` — the cutover operator script (dry-run by
  default; `--confirm` executes). Hermetically rehearsed: 51/51 checks green
  (see §7).
- `scripts/rotation-rehearse.sh` — the hermetic rehearsal. Runs the cutover
  against a fixture board through a `gh` shim (no network, no live state) and
  self-asserts every invariant. Re-run any time: `bash scripts/rotation-rehearse.sh`.
- This document — the authoritative end-to-end procedure.

## 1. Lineage and the third mailbox

The claims board has a lineage, not a single issue:

- `#11` — hit GitHub's 2,500-comment hard limit; comment-locked (403 on new
  comments); read-only archive.
- `#266` — "Claims board (continued from #11)". Live board. Filling.
- **Successor** — a new issue titled exactly `Claims board (continued from #266)`.
  Created at rotation time, not before.

The **third claims mailbox** is the successor issue. It does not exist yet and
must not be created early (an early empty issue invites confusion and splits
the board).

If GitHub itself is down at rotation time, the interim mailbox is the
`swarm-fallback` branch (lane notes under `fallback/<lane>-<utc>.md`, schema in
§6). It is interim only: notes are transcribed to the successor issue once
GitHub returns. It is never the normal third board.

Trigger: rotation is due when the live board's comment count is **strictly
above** the threshold (`--threshold`, default 1500; the cutover refuses to run
at or below it). Note: `docs/ROOM-WATCH.md §8.1` says "strictly above 1500"
while `scripts/room cmd_rotation_check` uses `-ge 1500`; the cutover implements
the stricter reading (fail-closed).

## 2. Preconditions (all must hold before `--confirm`)

1. The coordinator has **disabled** the `swarm-room-watch` cron (prevents
   mid-cutover tick races). The cutover cannot do this itself.
2. The operator runs the cutover from a **fresh `origin/main` checkout**
   (the script needs main's `scripts/room` for `_parse`/`_state`).
3. `--watermark-file` points at the live watermark file
   (`~/workspace/goals/agent-swarm-coordination/hidden_files/room-watch-watermark.txt`).
   Its first line must be numeric.
4. `--known-lanes` lists the active lane names (comma-separated) so the ledger
   can report which lanes carried nothing.
5. No successor issue with the exact title exists (the script checks and
   refuses to create a second).

## 3. Cutover procedure (what `--confirm` does, in order)

1. **Preflight.** Count check (REST `issues/266`, `.comments`), threshold gate,
   existing-successor refusal. Any failure aborts before any write.
2. **Quiet-window notice.** A prose comment on #266 (no protocol prefix — it
   changes no machine state): rotation is starting, please hold new claims.
3. **Quiet window.** `--quiet-seconds` (default 300). Lanes should not post;
   anything posted anyway is captured in step 4.
4. **Re-read the board tail.** The final old-board watermark `W_FINAL` is the
   maximum comment id **after** the quiet window — quiet-window stragglers are
   included, so the old watcher can process them before the handoff.
5. **Build the carry-over ledger** from live `_parse`/`_state` (§4).
6. **Create the successor issue** (title exactly
   `Claims board (continued from #266)`; body links the lineage and the
   protocol doc).
7. **Post two comments on the new issue, in order:**
   - header (lineage banner, protocol pointer, watermark pointer — prose, no
     claim blocks);
   - the `[room-watch][rotation-handoff]` ledger (§4).
8. **Post the closing link on #266** (prose): board moved to `#N`, this issue
   stays open as a read-only archive, final handoff watermark, carried count,
   pointer to the ledger.
9. **Rewrite the watermark file atomically** (temp + rename): line 1 becomes
   the new board's header comment id; a `# rotation: #266 -> #N, final
   watermark <W_FINAL> (...)` history line is appended; prior content is kept
   as `# prev:` lines. The file's first line stays numeric — the cron reads
   only the first numeric line.
10. **Emit the cron-repoint payload** (stdout, and to `--cron-payload-out`).
    The script does not touch the scheduler.
11. (Optional, default on) **Open the pointers PR**: `DEFAULT_ISSUE` 266→N in
    `scripts/room`, branch `jill/board-rotation-pointers-N`, PR against main.
    Merge on exact-head full-green CI per standing authority.
12. (Optional, default on) **Rebuild ROOM-STATE.md for the new issue** and push
    the `room-state` branch (uses a full clone; never a shallow one).

Dry-run (default, no `--confirm`) performs steps 1–5 read-only, prints the
carry preview (`carry preview (current state): N claim(s): <ids>`), the full
plan, and exits 0 without any write.

## 4. Carry-over semantics (the ledger)

The ledger comment opens with `[room-watch][rotation-handoff]` and carries:

```
[room-watch][rotation-handoff]
old issue:    #266
new issue:    #999
watermark:    <W_FINAL>
cutover at:   <utc>
open claims:
- <task-id> lane=<lane> state=<state> claim-at=<original-iso> lease_expires=<iso> [via=handoff-from-<lane>]
unclaimed lanes: <csv> | (none)
missing receipts:
<task-id> lane=<lane> completed <iso> — no room-receipt block
  | (none)
machine board: <room-state commit url>
```

**Carried:** claims that are non-terminal AND whose lease has not expired at
cutover time. Carried lines keep the **original** `claim_at` and the
**original** `lease_expires_at` — leases do not reset on migration. A claim
that moved lanes via handoff keeps its current lane and gains
`via=handoff-from-<previous-lane>`.

**Not carried:** terminal claims (done/released, with or without receipt),
expired claims, strike-closed claims. They remain in #266's history.

**Missing receipts:** completed-without-receipt claims older than 24h are
listed (not carried) so the new board's watchers know what to chase.

The old board's watcher processes every comment up to `W_FINAL` before the
handoff; the new board's watcher starts at the header comment id. The consumer
walk (§7, check I) proves every comment id is processed exactly once.

## 5. Watermark file format

The watermark file stays machine-readable:

```
6000000001
# rotation: #266 -> #999, final watermark 5849000023 (2026-09-26T21:35:27Z)
# prev: 5849000020
```

- Line 1: the active watermark (numeric). The cron reads only the first
  numeric line.
- `# rotation:` lines: append-only history, newest last.
- Never put non-comment text on line 1; never delete history lines.

## 6. Third mailbox: `swarm-fallback` branch (GitHub-down interim only)

Only if GitHub is unreachable at rotation time:

```bash
git fetch origin
git checkout -b swarm-fallback origin/main   # or check out the existing branch
mkdir -p fallback
```

Each lane writes `fallback/<lane>-<utc>.md` (UTC, `YYYYMMDDTHHMMSSZ`):

```markdown
lane: <lane>
utc: <iso>
status: active|idle
open-claims:
  - <task-id>
blockers: []
contact: <how to reach you when GitHub returns>
```

Commit and push per lane. When GitHub returns, transcribe every note to the
successor issue as a claim/status comment, then continue on the issue. The
branch is never the normal board.

## 7. Verification evidence (rehearsal)

`scripts/rotation-rehearse.sh` runs the cutover against a 20-comment fixture
board (every carry class: live claim, fresh claim, handoff+ACK, expired claim,
terminal with receipt, terminal missing receipt, prose noise) plus two
quiet-window stragglers, through a `gh` shim. No network, no live state.

**51/51 checks green** (2026-09-26). What the rehearsal proves:

- **Fail-closed gates:** under-threshold run exits non-zero with zero posts and
  an untouched watermark; dry-run exits 0 with zero posts and an untouched
  watermark.
- **Dry-run previews the carry set** (`carry preview (current state): 3
  claim(s)`) before any write.
- **Successor** created with the exact lineage title.
- **New board:** header comment first (id `6000000001`, prose, no claim
  blocks), ledger second (id `6000000002`).
- **Ledger:** `[room-watch][rotation-handoff]`, final watermark `5849000023`
  (includes the quiet-window stragglers), exactly the 3 live unexpired claims
  with original `claim-at` timestamps, handoff lane preserved
  (`lane=codex via=handoff-from-instinct`), expired/terminal claims excluded,
  missing-receipt claim listed, unclaimed lanes reported.
- **Old board:** closing link posted after the re-read (id `5849000024` >
  final watermark), naming the successor and the final watermark.
- **Watermark file:** atomic rewrite; line 1 = header id; rotation history
  appended; prior watermark preserved as `# prev:`.
- **Cron payload:** documents the exact old→new replacements (`issue #266` →
  `issue #999`, `issues/266/comments` → `issues/999/comments`).
- **Consumer walk:** every comment id across both boards processed exactly
  once — zero lost, zero double.
- **New board renders:** `scripts/room --issue 999 rebuild` succeeds on the
  two setup comments before any lane claims.
- **Third mailbox:** two lane notes round-trip on a `swarm-fallback` branch
  with the required schema.
- **Pointers sed** (`DEFAULT_ISSUE` 266→999) touches exactly one line.

**Not covered by the rehearsal** (pre-existing, tested behavior; not
re-proven here): the `room-state` branch push over a real remote
(`--commit-push`), and the real `gh issue create` URL-fallback path.

## 8. Coordinator checklist (the one-tap approval)

John's approval is a single tap: the phrase

> **rotate the board**

On that tap, the coordinator (not the script):

1. **Before:** `cron.update` — disable `swarm-room-watch`.
2. Run `scripts/rotation-cutover.sh --confirm` from a fresh `origin/main`
   checkout (with `--watermark-file`, `--known-lanes`, `--cron-payload-out`).
3. `cron.update` — apply the payload's replacements to `swarm-room-watch`
   (keep everything else byte-identical); `cron.view` to verify.
4. `cron.update` — re-enable `swarm-room-watch`.
5. Merge the pointers PR on exact-head full-green CI.
6. Digest to John: new board `#N`, carried count, final watermark.

## 9. Rollback

- If the cutover fails **before** step 6 (successor creation), nothing was
  written: re-run after fixing the cause.
- If it fails **after** the successor exists but **before** the watermark
  rewrite: the old board is still live and the old watcher still points at it.
  Re-run; the existing-successor check will refuse — delete the empty
  successor issue first (it has only the two setup comments), or complete the
  remaining steps by hand from the run's stdout.
- If the watermark was rewritten but the cron was not repointed: the watcher
  is disabled (precondition 1), so no tick runs against the wrong board.
  Repoint the cron by hand from the payload, verify with `cron.view`, re-enable.
- The old issue is never deleted or locked; its history is the audit trail.

## 10. Known limits

- The cutover cannot disable/repoint the scheduler itself; those are
  coordinator steps (§8). The script emits the exact payload.
- The quiet window is cooperative, not a lock: a lane that posts during it is
  captured (step 4 re-reads), not rejected.
- `swarm-fallback` transcription is manual.
- Trigger-threshold wording differs between `docs/ROOM-WATCH.md §8.1`
  ("strictly above 1500") and `scripts/room` (`-ge 1500`); the cutover uses
  the stricter reading.
- Rehearsal uses fixture ids; the id-monotonicity property (closing link id >
  final watermark) is modeled by the shim, not proven against GitHub.

<!--
  Rowboat port, Wave 3 (R7): the human plane of the room trust loop.
  Scheduler/board discipline adapted from rowboatlabs/rowboat
  (https://github.com/rowboatlabs/rowboat), (c) rowboatlabs, licensed under
  the Apache License 2.0. Here: one concise weekly brief for John, not a
  dashboard — CHAOSS-style health metrics + a trust digest read off the
  machine plane (ROOM-STATE.md / scripts/room verbs), never hand-computed.
-->

# ROOM-HEALTH.md

The human plane of the project-room trust loop. Machine state lives in
the `ROOM-STATE.md` board artifact (rebuilt by `scripts/room rebuild` on
the `room-state` branch; the committed root copy is a frozen 2026-09-16
snapshot that batch B1 deletes — the tool regenerates the artifact when
run). This file carries the generator contract, the week-over-week trend
lines, and — only while it is fresh — the latest generated digest.

Generator: `scripts/room-digest` — read-only against the board, never
posts. The "Latest digest" section is a point-in-time snapshot: do not
hand-edit it, regenerate it with the script.

**Live / stale boundary.** No digest is "latest" unless generated within
the F-01 aging threshold (35 days — truth-layer §5, check 4). A digest
older than that is stale: it leaves this file for `archive/` and is never
presented as latest. The trend rows below are dated history, not current
state. Everything else in this file is standing text — the generator
contract and the appendices — and does not age with a digest.

## Latest digest

No current digest. The last generated digest (week ending 2026-09-16,
generated 2026-09-16T18:32:49Z) passed the 35-day threshold and was
removed from this living file under truth-layer T-15 (SD-27); it is
preserved byte-identical at `archive/ROOM-HEALTH-digest-2026-09-16.md`.

To refresh: generate a new digest with `scripts/room-digest` and replace
this section with its output via a normal PR (Appendix A, step 6). Do
not hand-edit a digest placed here.

## Trend lines

Week-over-week, newest last. Each weekly run appends exactly one row (see
Appendix A); the machine-readable source is the `<!-- trend: ... -->`
comment at the foot of each generated digest.

| week ending | opened | completed | expired | receipts | missing (SLO) | refusals | board comments | rotation due |
|---|---|---|---|---|---|---|---|---|
| 2026-09-16 | 2 | 0 | 0 | 0 | 0 | 0 | 269 | no |

The single row is the baseline from the first digest (now archived).
It records the week ending 2026-09-16 only; it is not current board
state and it is not a latest digest.

## Appendix A — weekly digest cron spec (PROPOSED — not enabled)

This spec is **proposed only**. Nothing has been created or enabled. The
`swarm-room-watch` cron has been **PAUSED since 2026-09-14**
(`enabled: false`, per John's direction, and Wave 2 left it paused);
re-enabling it — and enabling this digest job — is **John's call**.

The digest job is the human plane to the watcher's machine plane: it
reads, it never posts, so it is safe to run while the watcher is paused.

```yaml
---
id: swarm-room-digest
title: Swarm room digest
enabled: false   # PROPOSED — enabling is John's call
owner: goal:agent-swarm-coordination
mode: task
schedule:
  kind: interval
  timezone: America/Los_Angeles
  every: 168h
---
```

Body (follows the `swarm-room-watch` convention — `interval@30m` — at a
weekly cadence, `interval@168h`):

1. Fresh clone of `Uuriko/project-room@main` into a temp dir per run (never
   a stale worktree). No commits to `main`, ever.
2. Read the window watermark:
   `~/workspace/goals/agent-swarm-coordination/hidden_files/room-digest-watermark.txt`
   — the ISO timestamp of the last window end (default: 7 days back on the
   first run).
3. Run, read-only:
   `scripts/room-digest --since <watermark> --out $RUN_DIR/room-digest-<date>.md`
   The script never posts to the board; findings are content, not failure.
4. Update the watermark atomically (write temp file, then rename) to the
   new window end. State lives with the scheduler, never in the repo
   (config/state split, `docs/ROOM-WATCH.md` §6).
5. Report: the full digest markdown is the brief for John (chat report),
   plus the `<!-- trend: ... -->` machine line for the trend table.
   Nothing is posted to the board.
6. Repo bookkeeping (by the runner, via a normal PR — repo discipline
   applies): replace this file's "Latest digest" section with the new
   digest and append the trend row to the table above.

Failure handling (same as the watcher, `docs/ROOM-WATCH.md` §5): on
repeated failure of a verb, post nothing new and do not retry blindly —
surface the verb, the error, and the last good watermark in the digest
instead. If `gh` rate-limits: stop; the next weekly run replays from the
watermark.

## Appendix B — running the digest by hand

```sh
git clone --depth 1 https://github.com/Uuriko/project-room.git /tmp/room-digest-run
cd /tmp/room-digest-run
./scripts/room-digest --dry-run                 # inspect, write nothing
./scripts/room-digest --out /tmp/digest.md      # default window: last 7 days
./scripts/room-digest --since 2026-09-09T00:00:00Z --out /tmp/digest.md
```

Flags: `--since ISO` (window start), `--out PATH` (atomic write),
`--dry-run` (plan to stdout, write nothing). Globals: `--repo`, `--issue`,
`--help`. The digest composes `scripts/room` verbs — `metrics --since`,
`receipts-scan`, `rotation-check`, `query --live` — plus event detail
through `room _parse`/`_state`; it reimplements no board parsing.

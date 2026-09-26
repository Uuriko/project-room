# /tmp gets reaped — keep work in persistent worktrees

**Date:** 2026-09-18 (first learned), reinforced 2026-09-20
**Applies to:** any lane running tests, clones, or uncommitted work

`/tmp` is a 512MB tmpfs shared by all agents and sits near 100%.
Another agent actively wipes `/tmp` — scratch files, shallow clones, and
whole worktrees vanish within minutes to hours. Two real losses:

- 2026-09-18: a full day's uncommitted implementation lost when
  `/tmp/stitch-quill` vanished.
- 2026-09-20: scratch files and shallow clones vanished mid-tick from
  room-watch.

**Rule:** never keep uncommitted work under `/tmp`. Use a persistent
worktree (`~/workspace/pr-<name>/`), commit early and often, remove the
worktree after the PR merges.

**Related:** run repo tests with `TMPDIR` pointed inside your worktree
(e.g. `TMPDIR=~/workspace/pr-<name>/.tmp`) — the shared `/tmp` also
causes `SQLITE_FULL` / `database-or-disk-is-full` failures in parallel
test runs.

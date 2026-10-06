# Weekly learnings queue

Lanes: append one line per lesson under the current ISO-week heading
(e.g. `## 2026-W41`), or under `## unfiled` if you are not sure which
week it belongs to. The weekly cron (`scripts/weekly-learnings.mjs`)
reads the current week plus `unfiled` and posts one digest to muse-room.

Format: `- [lane] one-line lesson` — the lane tag is optional but helps
others follow up. Keep it to one line, no noise.

Weeks with fewer than 3 total signal items are skipped (anti-spam), and a
week is never posted twice.

## 2026-W41

<!-- example: - [jill] Never `git stash` in the shared checkout while parallel worktrees are active. -->

## unfiled

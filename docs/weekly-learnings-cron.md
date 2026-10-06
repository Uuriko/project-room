# Weekly learnings cron — definition

Backlog W007. One runtime cron that runs `scripts/weekly-learnings.mjs`
and posts a single digest to muse-room every week.

## Registration

Register via the runtime cron tool (these crons live outside the repo,
like `wave-seeder` and `verified-digest`):

- **Name:** `weekly-learnings`
- **Schedule:** weekly, Mondays ~08:05 PDT (before the wave-seeder at
  ~09:22 PDT, so lanes start the week with last week's lessons).
- **Command / instructions:**
  `cd <project-room checkout> && node scripts/weekly-learnings.mjs --post`
  Run from a checkout on `origin/main` (the script resolves
  `docs/WEEKLY-LEARNINGS.md` relative to its own location). `gh` must be
  authenticated and `~/.config/jill-room/{conn/connection.json,identity.json}`
  must exist (same credentials as `~/workspace/jill-plugin/post-room.mjs`).

## Behavior

- Gathers: merged PRs of the last 7 days (`gh pr list --state merged`),
  room DONE / BUG CONFIRMED posts since the stored watermark, and the
  current week's entries in `docs/WEEKLY-LEARNINGS.md` (+ `## unfiled`).
- Renders one digest: SHIPPED / BROKE & FIXED / LEARNED / DONE THIS WEEK,
  each section capped, whole post hard-capped at 4000 chars.
- Anti-spam: skips the week when total signal items < 3. Skips when the
  ISO week is already in the sent log — a week is never posted twice.
- Watermark policy (fail-closed): the room cursor is committed ONLY after
  a successful post. Dry runs, skips, and failed posts never advance it —
  dry runs are strictly read-only. If the event walk hits the page cap
  with more events pending, the run fails without posting and preserves
  the partial cursor + original window, so the next run resumes the walk
  instead of permanently skipping the rest.
- State dir (default `~/.config/weekly-learnings/`): `sent.log`
  (posted weeks) and `room-watermark.json` (`{after, windowStartMs}`).
  Override with `WEEKLY_LEARNINGS_STATE_DIR`.

## Manual runs

- Dry run (default, prints the digest, posts nothing):
  `node scripts/weekly-learnings.mjs --dry-run`
- Specific week / window:
  `node scripts/weekly-learnings.mjs --week 2026-W41 --since 2026-09-29T00:00:00Z --dry-run`
- Exit 0 on ok / dry-run / skip; 1 on error (gh failure, room API
  failure, bad flags).

## Tests

`tests/weekly-learnings.test.js` — digest format, lesson extraction,
room-signal filtering, queue parsing, skip-when-empty, idempotency,
section caps, length cap. Run:
`TMPDIR=<worktree>/.tmp node --test tests/weekly-learnings.test.js`

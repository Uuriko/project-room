# Knowledge base — front door

Durable agent memory for Project Room lanes. Markdown is authoritative;
anything derived from it is rebuildable. Write here so the next lane
doesn't have to learn it the hard way.

**Read path:** `grep -r kb/` at task start. Promote to an index only when
grep stops being enough.

**Write path:** see `docs/ROOM-PROTOCOL.md` §4b.

## Notes — reusable learnings

- [tmp-reaping](notes/tmp-reaping.md) — `/tmp` gets wiped; keep work in
  persistent worktrees, point `TMPDIR` inside the worktree for tests.
- [room-dry-run-flag-order](notes/room-dry-run-flag-order.md) —
  `scripts/room` flags are global and must precede the verb.
- [browser-check-ab-diagnosis](notes/browser-check-ab-diagnosis.md) — A/B
  test browser check failures before trusting the first diagnosis.

## Plans — what a claim attempted and learned

- [RC-2026-09-25-912](plans/RC-2026-09-25-912.md) — self-serve guest
  entry (#1077) and the Burs-IA replay security repair (#1078).

## Decisions — why, with date and decider

- [merge-queue-native](decisions/merge-queue-native.md) — GitHub-native
  merge queue over a lane-run bot (S3).
- [light-factory-no-automerge](decisions/light-factory-no-automerge.md) —
  autonomous loops open PRs, never merge.

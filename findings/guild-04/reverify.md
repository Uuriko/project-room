# wave1000 guild-04 — re-verify of wave branches touching the slice

Method per branch: disposable worktree (`~/workspace/wt-g04-rv-N`), scratch branch
from `origin/<branch>`, rebase onto current `origin/main` (retry loop for transient
worktree interference), run the affected test file(s) with worktree-local TMPDIR,
adversarially review the slice diff. Logs: `findings/guild-04/reverify-N.log`.

## Results

| # | Branch | Slice files | Rebase | Tests | Verdict |
|---|---|---|---|---|---|
| 1 | wave300/fix4-eventlog-read-scale | store.mjs | OK | 11/11 pass | ✅ clean — stmt caching + flipExpiredMentions bypasses projection-cache invalidation via storagePlatform.transaction; sound |
| 2 | wave300/fix69-event-light-claims | room-guide.mjs, work-claim-sqlite.mjs | … | … | pending |
| 3 | wave300/payload-store | store.mjs | OK | 32/32 pass | ✅ clean — additive PayloadStore wiring, readOnly-guarded, runtime-package allowlist updated |
| 4 | wave300/sharded-claim-boards | work-claim-sqlite.mjs | … | … | pending |
| 5 | wave400/docs-core | room-assistant.mjs, room-key-presence.mjs, store.mjs | OK | 29/29 pass | ✅ clean |
| 6 | wave400/elegant-rooms-a | room-attachment-bytes, room-directory, room-export-html, room-export | OK | 29/29 pass | ✅ clean — pure refactor (merged tableOrder, behavior-preserving sanitizeCell) |
| 7 | wave400/elegant-server | same 4 | … | … | pending |
| 8 | wave400/elegant-wcmisc | same 4 + work-claim-sqlite | … | … | pending |
| 9 | wave400/elegant-wcroutes-b | same 4 | … | … | pending |
| 10 | wave400/perf | store.mjs, work-claim-sqlite.mjs | … | … | pending |
| 11 | wave400/perf-index-audit-r2 | store.mjs | … | … | pending |
| 12 | wave400/perf-stmt-cache-r2 | work-claim-sqlite.mjs | … | … | pending |
| 13 | wave500/presence | store.mjs | … | … | pending |
| 14 | wave500/presence-w2-pump | store.mjs | … | … | pending |
| 15 | wave500/presence-w3-pump-tests | store.mjs | … | … | pending |
| 16 | wave500/presence-w4-delta | work-claim-sqlite.mjs | … | … | pending |

## Adversarial diff notes (from direct review)

- **fix4**: the only behavioral change is `flipExpiredMentions` bypassing
  `RoomStore#transaction` (projection-cache invalidation) for a mention_states-only
  write. Atomicity preserved via `storagePlatform.transaction`; typed error mapping
  kept. Cached prepared statements (`??=`) on hot reads — safe under node:sqlite
  (auto re-prepare on schema change).
- **payload-store**: +11 lines in store.mjs; PayloadStore constructed after the
  version check, skipped on readOnly opens. No behavior change to existing paths.
- **perf**: additive expression index `events_workitem_id`; per-registry prepared
  statement cache in work-claim-sqlite (lazy — safe vs the pre-migration
  construction noted in the code comment).
- **elegant-rooms-a**: pure refactor, no behavior change (verified by 29/29).

## Environment note

A transient external process rewrites files inside fresh worktrees (observed:
`tests/work-claims.test.js`, `docs/SERVICE.md` modified and reverted within ~60s),
which intermittently fails `git rebase` with "local changes would be overwritten".
`merge-tree` confirms the affected branches have no real conflicts; `rv-unit.sh`
retries the rebase (up to 8 attempts with `git checkout -- .` before each) and
only runs tests on a successfully rebased tree.

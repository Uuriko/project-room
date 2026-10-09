# wave1000 guild-04 — re-verify of wave branches touching the slice

Method per branch: disposable worktree (`~/workspace/wt-g04-rv-N`), scratch branch
from `origin/<branch>`, rebase onto current `origin/main` (retry loop for transient
worktree interference), run the affected test file(s) with worktree-local TMPDIR,
adversarially review the slice diff. Logs: `findings/guild-04/reverify-N.log`.

## Results (final, 2026-10-09 — third coordinator)

| # | Branch | Slice files | Rebase | Tests | Verdict |
|---|---|---|---|---|---|
| 1 | wave300/fix4-eventlog-read-scale | store.mjs | OK | 11/11 pass | ✅ clean — stmt caching + flipExpiredMentions bypasses projection-cache invalidation via storagePlatform.transaction; sound |
| 2 | wave300/fix69-event-light-claims | room-guide.mjs, work-claim-sqlite.mjs (+routes, claim-pr-sync) | ❌ CONFLICT (semantic) | — | 🔴 breakage: conflicts in server/claim-pr-sync.mjs (main `emitWorkClaimEvent` × branch `emitWorkClaimEventRouted` — digest-batched emit redesign vs main's direct path; not mechanical), work-claim-routes.mjs import (`claimHistoryLength` × `touchWorkClaim`/`isLeaseExpired` — union-able), tests/work-claim-events.test.js. Owner must reconcile the event-light digest design with main's current emit path |
| 3 | wave300/payload-store | store.mjs | OK | 32/32 pass | ✅ clean — additive PayloadStore wiring, readOnly-guarded, runtime-package allowlist updated |
| 4 | wave300/sharded-claim-boards | work-claim-sqlite.mjs (+routes) | ⚠️ CONFLICT (mechanical) | 13/13 pass after union | ⚠️ rebase needs a union: work-claim-routes.mjs import adds main's `claimHistoryLength` to the branch's namespace helpers (all bindings exist on both sides; body usage of claimHistoryLength already on both). Resolved in scratch, work-claim-sqlite + work-claim-boards tests green |
| 5 | wave400/docs-core | room-assistant.mjs, room-key-presence.mjs, store.mjs | OK | 29/29 pass | ✅ clean |
| 6 | wave400/elegant-rooms-a | room-attachment-bytes, room-directory, room-export-html, room-export | OK | 29/29 pass | ✅ clean — pure refactor (merged tableOrder, behavior-preserving sanitizeCell) |
| 7 | wave400/elegant-server | same 4 | OK | 29/29 pass | ✅ clean |
| 8 | wave400/elegant-wcmisc | same 4 + work-claim-sqlite | OK | 31/31 pass | ✅ clean |
| 9 | wave400/elegant-wcroutes-b | same 4 | ❌ CONFLICT (semantic) | — | 🔴 breakage: STALE vs QA-200 failseq fixes. work-claim-routes.mjs conflicts at 3 hunks where main has H4's improved 409 messages ("name the real recovery") and E5's `expectedClaimedAt`/`expectedHistoryLength` compare-and-release; the branch's versions predate both. A naive rebase would REGRESS two deliberate post-QA-200 contract changes. Owner must re-apply the simplification on top of main's hunks |
| 10 | wave400/perf | store.mjs, work-claim-sqlite.mjs | OK | 3/3 pass | ✅ clean — additive expression index + per-registry stmt cache |
| 11 | wave400/perf-index-audit-r2 | store.mjs | OK | 1/1 pass | ✅ clean |
| 12 | wave400/perf-stmt-cache-r2 | work-claim-sqlite.mjs | OK | 2/2 pass | ✅ clean |
| 13 | wave500/presence | store.mjs | OK | 12 pass / 3 fail | ⚠️ the 3 failures are the branch's OWN FAIL-FIRST tests (24h churn ghost-row pruning, delta subscription, poll-traffic liveness refresh) — they fail identically at the branch's un-rebased head (verified: 7 pass / 3 fail pre-rebase), so NOT a rebase regression. Branch ships aspirational tests its implementation doesn't satisfy yet |
| 14 | wave500/presence-w2-pump | store.mjs | OK | 5/5 pass | ✅ clean |
| 15 | wave500/presence-w3-pump-tests | store.mjs | OK | 15/15 pass | ✅ clean |
| 16 | wave500/presence-w4-delta | work-claim-sqlite.mjs | OK | 2/2 pass | ✅ clean |

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

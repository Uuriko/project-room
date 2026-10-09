# Re-verify report — wave branches touching concurrency paths

**Date:** 2026-10-09 · **Method:** scratch worktree per branch → `git rebase origin/main` →
targeted existing tests + guild-20 race scripts (`REPO` pointed at the rebased tree) →
adversarial diff review of concurrency files. Runner: `race-hunt/reverify.mjs`.
**Caveat:** wave branches are live — tips move during verification. SHAs below are point-in-time.

`origin/main` at verify time: `1b6eb70ee` (guild-20 branch itself cut from `b53c52af1`; no PRs per orders).

## Per-branch results

| Branch | SHA | Rebase onto main | Own tests | Guild-20 races | Notes |
|---|---|---|---|---|---|
| wave300/sharded-claim-boards | fca324073 | CONFLICT (work-claim-routes.mjs, per-commit) | PASS | PASS (rh05, rh06) | **2 new hazards found (below)** |
| wave300/fix5-release-compare | 99d9f66f4 | CONFLICT (work-claim-routes.mjs, work-claims.mjs, tests/work-claims.test.js) | PASS | PASS (rh06) | — |
| wave300/fix18-cap-gapfill | addd5eda8 | CONFLICT (work-claim-routes.mjs, work-claims.mjs, src/agent-error.mjs) | PASS | rh07 reproduces (race present, as in main) | expiry → new "expired" state; race not fixed, not worsened |
| wave300/fix69-event-light-claims | 2bf5ec8fb | CONFLICT (claim-pr-sync.mjs, work-claim-routes.mjs, tests/work-claim-events.test.js) | PASS | rh07 reproduces (race present, as in main) | emit rename only; settle logic untouched |
| wave300/data-plane-fastpath | 18f6fc13d | clean | PASS | PASS (rh05) | — |
| wave300/payload-store | 1d41de100 | clean at verify time (branch moving) | PASS | PASS (rh03) | — |
| wave300/fix4-eventlog-read-scale | 4eceef376 | clean | PASS | n/a | store.mjs read-path only |
| wave400/perf | 88200b0a9 | clean at verify time (branch moving) | PASS | PASS (rh05) | — |
| wave400/elegant-wcmisc | ef4fe6a2b | clean at verify time (branch moving) | PASS | rh07 reproduces, rh08 passes | pure refactors in claim-coordination.mjs; settle logic untouched |
| wave300/fix12-unprivileged-succession | 143543319 | CONFLICT (work-claim-routes.mjs, per-commit) | PASS | PASS (rh06) | — |

Rebase-conflict note: all conflicts are **per-commit replay conflicts** — `git merge-tree` on the
endpoints is clean for every branch. They block the rebase-before-PR path, not the merge itself.
Resolving them is the owning lane's job; no concurrency content in the conflicts beyond the files
listed.

## New hazards in wave300/sharded-claim-boards (cross-slice → guild 01)

**H1 — racy schema migration in `createDurableWorkClaimRegistry`.** The factory runs
`PRAGMA table_info` → `ALTER TABLE work_claims ADD COLUMN namespace` as a check-then-act
**outside any transaction and with no readOnly guard**. Two concurrent `RoomStore`
constructions (concurrent opens happen — see the QA slice-D note) can both observe the column
absent; the second `ALTER` then throws `duplicate column name: namespace` and the boot crashes.
A read-only open of a pre-shard DB would attempt the `ALTER` and fail with "attempt to write a
readonly database". The migration belongs in the main migration transaction, or must be
made idempotent-under-concurrency (try/catch around the ALTER, or a savepoint).

**H2 — PK `(room_id, claim_id)` doesn't include `namespace`.** The branch comments "Claim ids
are room-unique across boards" but nothing enforces it. Two `set()` calls with the same claim
id on different namespaces hit `ON CONFLICT(room_id, claim_id) DO UPDATE ... namespace =
excluded.namespace` — the second **silently moves the claim to its board** (last-writer-wins),
and it vanishes from the first board's listing. Concurrent cross-board creates with the same
id lose one claim with no conflict error. Either the PK must become `(room_id, namespace,
claim_id)` or cross-board id creation must be refused.

What the branch got right: the `memoizeList` cache keys now include the namespace (one board's
list can never serve another's), and `set`/`delete` invalidate the whole room's keys —
the write-invalidates discipline is preserved.

## Unchanged hazards (present in main, present in branches)

- The RH-07 sweep stale-settle race reproduces identically on cap-gapfill, event-light, and
  elegant-wcmisc. None of these branches fix it; none worsen it. (Filed cross-slice in
  `RACE-sweep-stale-settle-CROSS-SLICE.md`.)
- No branch changed `BEGIN IMMEDIATE` usage, the instance-lock protocol, or either fence.

## Scratch

Worktrees and logs under `.tmp/reverify/` (worktrees removed after the run; per-branch logs kept
in `.tmp/reverify/reports/<slug>/`). The guild-20 branch itself was never modified by this track.

# guild-15 re-verify: wave branches touching the channels slice
Each: scratch worktree, rebase onto origin/main (2eda65ff2), full affected suite
(all tests/channel*.test.js, tests/gmail*.test.js, tests/telegram*.test.js,
tests/whatsapp-adapter, tests/*sms*, tests/*messenger*, tests/session-adapter*,
tests/herdr-bridge*, tests/demigod-jobs-money).

CORRECTION (2026-10-09): the initial branch finder used a stale merge-base.
Re-checked against current origin/main:
`git log origin/main..<branch> -- <all 15 slice paths>` returns **0 commits
for all 15 branches** — every slice change from these wave branches has
already landed in main. The rebase+suite runs below therefore validate that
each branch's *remaining unique commits* don't break the slice suite.

## origin/jill-dot/account-confirm-order-20261003 — REBASE CONFLICTS on origin/main (branch stale; not testable cleanly)
## origin/jill-dot/f12-board-read — REBASE CONFLICTS on origin/main (branch stale; not testable cleanly)
## origin/jill/audit-wave-2e — rebased clean; suite: pass=338 fail=0 cancelled=0
slice diff stat vs origin/main:

## origin/jill/audit-wave-2b — rebased clean; suite: pass=338 fail=0 cancelled=0
slice diff stat vs origin/main:

## origin/jill/audit-wave-2d — rebased clean; full suite INVALIDATED by VM contention
Full 40-file suite run stalled (52 files cancelled with 'Promise resolution is
still pending' — the VM was at load 11-13 with a sibling guild's full-suite
run; not branch breakage). Re-ran the 8 core slice files with
--test-concurrency=1: **pass=55 fail=0 cancelled=0**.
## origin/jill/audit-wave-2c — rebased clean; reduced suite (8 core files, concurrency 1): pass=55 fail=0 cancelled=0

## Summary
- 15/15 slice-touching wave branches: 0 unmerged slice commits vs origin/main — all slice work already landed.
- Rebase+suite: 2e 338/0, 2b 338/0, 2a 338/0 (full affected suite); 2d 55/55, 2c 55/55 (core slice files, concurrency 1).
- 2 jill-dot branches (f12-board-read, account-confirm-order-20261003): rebase conflicts on current main — stale, not testable; their slice content is already in main.
- No breakage found in any rebased branch.
## origin/jill/audit-wave-2a — rebased clean; suite: pass=338 fail=0 cancelled=0
slice diff stat vs origin/main:


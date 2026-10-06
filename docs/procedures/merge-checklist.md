---
id: swarm.merge-checklist
title: Merge checklist
version: 1.0.0
author: jill (lane burn-shared-procedures)
source_room: muse-room
updated: 2026-10-06
status: active
---

# Merge checklist

Every PR merges only when all of these hold. Ported from the validated swarm
procedures (muse-room, 2026-09-16).

1. PR state is MERGEABLE / CLEAN.
2. All hosted checks green on the exact head (contract, lint, tests,
   cloudflare, browser, plus approvals).
3. Full local `npm run check` — 0 failures.
4. Rebase onto the current main tip immediately before final validation;
   never merge a head more than ~2h behind main without rebasing.
5. Merge only after the reviewer's explicit APPROVE on the exact head
   (lander rule). Never merge while a CHANGES REQUESTED verdict is open
   (merge-hold rule).
6. On conflicts in another lane's file: stop and ask in the room rather than
   resolving blindly.

## Merge receipt

Post a SHA-pinned receipt to the room when the PR merges:

- PR number and merge commit SHA (short).
- What changed (files added/edited, one line each).
- Schema / storage / migration impact, or the explicit word "none".
- Check counts: hosted (x/y green) and local (`npm run check`: pass/fail).
- The sentence "claim released" (or which claim remains open).

Consequential room posts (plans, ownership claims, handoffs, votes) get a
read-back check: fetch the event log and confirm the message appears.
"Posted ok" is submission, not delivery.

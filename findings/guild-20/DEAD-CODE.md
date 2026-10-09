# Dead code review — concurrency slice

Candidates examined for reachability. **Verdict: no dead code found in the slice.** Everything
below is live, with the evidence.

## Examined and LIVE

- `server/instance-lock.mjs` — used by `server.mjs:16,43` (boot). Registered as optional in
  `scripts/runtime-package.mjs:315`. Covered by `tests/instance-lock.test.js`.
- `server/writer-fence.mjs` — `registerWriter`/`installWriterFence`/`verifyWriterFence` wired into
  `server/store.mjs` via `nodeStorage` (`configure`, migration, `auditRecovery`). The retained
  `project_room_writer_v6`…`v27` function registrations look vestigial but are **live**: old
  triggers from deployed v28 lineage (`deployedV28FenceDefinitions`) call them, and
  `verifyWriterFence` accepts that history. Removing them would break opens of v28-era databases.
- `server/public-work-claim-fence.mjs` — `withPublicWorkClaimWriter` used by the public-claim
  write paths; triggers installed by schema; `verifyPublicWorkClaimFence` called at open.
  `allowAbsent` option is live (v27 read-only opens of pre-journal files).
- `server/sla-clocks.mjs` — used by `server/inbox.mjs` and `server/sla-dashboard.mjs`. Pure
  functions; no shared state (rh19).
- `server/ip-blocklist.mjs` — used by `server/http.mjs`, `server/outbound-webhooks.mjs`,
  `server/web-fetch.mjs`, `server/webhook-dispatch.mjs`. Pure parsers; no shared state.
- `server/merge-queue.mjs` `createMergeSlotQueue` — in-process phase-1 slot; the
  `sharedMergeQueueRegistry` is the per-room holder. No durable counterpart exists yet —
  that's a documented limitation (CONCURRENCY-MODEL.md), not dead code.
- `invitationJournalEntry`'s `prior` chaining / `replayInvitationJournal` — exercised by the
  journal verification paths, not just tests.
- `syncClaimReputationJournal`'s legacy-row rebuild branch (`legacyRowsRemoved > 0` → widen to
  all rooms) — live for pre-`room_id` databases; the `widenedToAllRooms` return flag is
  consumed by callers.

## Near-misses (kept deliberately)

- `src/multi-instance-election.mjs` — already deleted; `instance-lock.mjs` header documents why
  (lease election for a multi-instance deploy that was never wired up). No resurrection needed.
- `claim-pr-sync.mjs` `!pull.outcome` predicate — mutation M-08 proved it is *not* load-bearing
  today (`settlePullRequest` guards independently), but it is the documented retry-safety
  mechanism. Keep.

## Method

`grep -rln` over `server/`, `scripts/`, `tests/`, `src/` for each module's filename and exported
symbols, plus import-graph spot checks. Anything with zero inbound references outside its own
test would have been listed here with the evidence — there were none.

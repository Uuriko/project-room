# Wake delivery guarantees (`server/wake-queue.mjs`)

A wake is a recorded intent to re-check something later. Draft class: nothing
here sends, posts, launches, or spends. Queue records are the member's own
intent.

## Lifecycle

```
enqueue → pending ──lease──▶ leased ──complete──▶ done
               │                │──fail (attempts left)──▶ pending (backoff)
               │                └──fail (exhausted)──────▶ dead ──requeue──▶ pending
               └──recover (crash, attempts left)──▶ pending
               └──recover (crash, exhausted)──────▶ dead   (M-18)
```

## Guarantees

1. **Coalescing** — one row per `(room_id, member_id, queue_key)`. A pending
   wake absorbs a re-enqueue: intent replaced, `due_at` keeps the **earliest**
   (`Math.min`). A leased wake is left alone. A done wake starts a fresh
   cycle. A dead wake refuses (`409 wake_dead`) until explicit `requeue()`.
2. **Crash-safe leases** — `lease()` is an atomic `UPDATE ... WHERE
   state='pending'`: exactly one winner. The attempt is counted at lease
   time. A dead process leaves an expired lease; `recover()` (runs at store
   open, non-readonly) returns it to pending **exactly once** — or to dead
   when attempts are exhausted, so a crash never grants an extra attempt.
3. **Receipt-idempotent completion** — the `requestId` receipt is written in
   the same transaction as the state change; a retried completion is a
   duplicate no-op and never applies a second effect. Idempotency binds
   `(requestId, queueKey)` via fingerprint: a colliding requestId from a
   different wake is `409 idempotency_conflict`, not a silent duplicate
   (M-19).
4. **Bounded retry** — `fail()` backs off `min(60000 * 2^(attempts-1),
   3600000)`; deterministic, no hot loop. Exhaustion → dead-letter.
5. **Pause is a stop control** — `due()` and `lease()` both exclude paused
   members (`NOT EXISTS` on `wake_queue_pause`). Pausing stops *new* attempts;
   an already-leased attempt finishes. Pause of another member needs owner or
   `manage_members`; a removed member's pause row is inert (resume refused).
6. **Receipt cap bounds every writer** — enqueue, pause, resume, requeue,
   complete (M-20). The commands table is append-only (triggers forbid
   UPDATE/DELETE), so the cap is the only bound on its growth. Pause that
   changes state is admitted at the cap (stop must work).
7. **Guest denial** — `enqueue()`/`requeue()` authenticate directly and
   bypass `store.command`, so the guest scope gate is enforced explicitly
   (`403 guest_scope_denied`).

## Failure modes that are *not* covered

- `recover()`'s exhausted-lease path had no test pinning it (found by mutant
  M04; fail-first regression added at
  `findings/guild-12/regress/recover-exhausted-dead.test.js`).
- `maxAttempts` boundary `5` (the legal max) has no enqueue test (mutant M06
  survived) — the value is accepted in production, just unpinned by tests.
- `baseBackoffMs`/`leaseMs` constant changes are not pinned (mutants M13/M14
  pending) — tests assert relative ordering (due after backoff), not the
  absolute durations.

## Restart proof

`tests/wake-queue.test.js` "done-when: a restart preserves intent without
duplicate action": close mid-lease, reopen → exactly one wake, state
`pending`, attempts counted once, intent byte-identical, re-leasable, and a
retried `complete()` applies the effect exactly once.

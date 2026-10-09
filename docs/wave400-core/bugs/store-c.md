# store-c suspected bugs — server/store.mjs lines 3501–5256

Nothing was fixed. Items are suspected from code reading only, not from
running tests.

- server/store.mjs:4303 — `eventsAfter()` calls `this.flipExpiredMentions(roomId)`
  BEFORE `this.authenticate(...)` (auth happens inside the readTransaction at
  4304). Result: a request with a missing/invalid token commits a DB write
  (flipping expired mentions) and then fails with 401. An unauthenticated
  caller — e.g. an SSE pump client on the documented 250ms cadence — can keep
  causing write transactions on every poll. Auth should run first, or the flip
  should be deferred until after auth.

What I checked (and found clean):
- `presence()` pushes `item.heartbeat_at` while the freshness gate uses
  `session.heartbeat_at` — not a bug: sessionRecord() derives its heartbeat
  from item.heartbeat_at and the filter guarantees it's a parseable string.
- `command.data.memberId` read (line ~4629) cannot throw — validateCommand
  (line 783+) requires command.data to be an object for every command type.
- `authenticate()` never sets `sessionRevision` on room-key auths, so
  `viewerSessionRevision` is null there — consistent, not a bug (only
  account-session auths at lines 2958/3119 carry a revision).
- `charter()` returns 404 (not 409) when the LIMIT-2 history query finds
  duplicate charter events for the same revision — a deliberate
  "can't-find-a-clean-version" choice, not clearly wrong.
- `mutateWorkSession` trip-wire commits its forced suspend/stop in its own
  transaction before the caller's mutation — documented intent (comment at
  3786), and the `rounds-`/`budget-` command-id prefixes prevent idempotency
  clashes on retry.
- `importEvents` doesn't resync the MSG-1 messages double-write table — not
  a bug today (no read path uses that table yet; MSG-2 backfill pending).
- All fail-closed gates (guest scope, bond permission bits, autonomy tiers,
  spend allowance, pilot limits, cleanup bypass) are ordered after
  idempotency replay and before the reducer apply, matching their comments.

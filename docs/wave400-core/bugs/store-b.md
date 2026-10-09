# Suspected bugs — server/store.mjs lines 1751–3500

Flagged, not fixed.

- `:staleMembers` — `days` defaults to 30 and `now` defaults to null (wall
  clock); a caller that forgets `now` in a test gets time-dependent results.
  Minor.
- `:backfillReferralDepth` — the correlated subquery updates `max_depth` from
  the invite's `max_depth`; if the invite row itself has NULL `max_depth`,
  the member row is "updated" to NULL and counts as `updated += changes`
  even though nothing meaningful changed — the tick may report progress
  forever on a chain of NULLs.
- `:loginAccountSession*` — several login variants (`loginAccountSession`,
  `loginAccountSessionWithMethod`, `loginAccountSessionWithGoogle`) share
  slot/rotation logic by duplication; a fix to one (e.g. the session-fixation
  handling) must be mirrored by hand.

Checked and clear: deferred-integrity cursor resumption, schema-stamp
comparison, transaction delegation, storage-failure counter, OAuth
pending-state consume-once semantics, invitation journal append.

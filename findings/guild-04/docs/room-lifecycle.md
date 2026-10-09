# server/room-lifecycle.mjs — room model & lifecycle

## Room identity

`createAccountRoom(roomId, ...)` — rooms have a stable `id` (≤64 chars; mutation L4
verified the cap is tested), an `ownerId`, and a `projection`. The `rooms` table
carries `archived_at TEXT` as the source of truth for archival; the projection
mirrors it at `$.room.archivedAt`.

## Startup audit

`verifyRoomLifecycle(store)` runs on every open (writable and read-only):
1. The `archived_at` column must exist → else "Room lifecycle schema requires
   operator reconciliation".
2. No row may disagree between `archived_at` and `json_extract(projection,
   '$.room.archivedAt')` → else "Room lifecycle requires operator reconciliation".
   Read-only opens never migrate or repair — they refuse.

`migrateRoomLifecycleV28` backfills the column for older databases (genuine v27
data gains `archived_at` exactly once — covered by the migration test).

## Archive semantics

`refuseArchivedWrite(state)` — archiving closes **every** write path: commands,
history import, and the join paths that append membership events. Reads, streams,
and export stay available. `isRoomArchived(state)` is the single predicate.

## Account room limits

`ACCOUNT_ROOM_LIMIT` caps rooms per account (`memberships.length >= LIMIT`
rejects the 101st — mutation L1 verified the boundary is tested).

## Create idempotency

Re-creating an existing room id with a *different* key fails 409 `room_exists`;
with the *same* idempotency key it is a no-op success (mutation L2 verified).
The `start` field validation (`request.start !== 1 && request.start !== true`)
is untested — mutation L5 (|| instead of &&, always rejects) survived; the start
field has no coverage (test-gap note in mutants.md).

## Gotcha

Archival is a state transition on the room, not a delete: archived rooms keep
their rows, events, and exports. The public directory filters them via
`archived_at IS NULL` (mutation D2 verified).

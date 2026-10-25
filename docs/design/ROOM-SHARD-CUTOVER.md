# Per-room Durable Object cutover

The code for one Durable Object per room is in the tree and dark. `ROOM_PER_ROOM_OBJECTS` is off unless it is exactly `1`. The checked-in Wrangler config does not set it. This document is the operator runbook. It is not permission to run the live steps.

Codex's release seat deploys. Potter's go is required before the flag is set, before any production copy, before any read is served from a room object, and before any pilot row is deleted. Nothing in this stack deploys, copies production, or flips the flag.

## What the deploy contains

- Class `RoomShard`, binding `ROOM_SHARD`, migration tag `room-shard-v1`. Tag `room-sqlite-v1` and class `ProjectRoom` are unchanged. Staging's `ROOM_SHARD` has no `script_name`, so staging does not attach to the production object.
- `resolveRoomHome` returns `invite-only-pilot` on binding `ROOM` unless the flag is on and that room's `storage_home` is `room`. Worker fetch does not call it. Fetch still uses `getByName('invite-only-pilot')`.
- `ensureStorageHomeIfEnabled` adds `rooms.storage_home` (`NOT NULL DEFAULT 'pilot'`) only when the flag is on. Opening a store does not add the column.
- `copyRoomRows` copies one room's room-tables by primary key. Accounts, credentials, and every other directory table stay on the pilot.
- `compareRoomHomes` reports `events`, `eventsHash` (sha256 over `sequence`, `id`, and `body` in sequence order), `messages`, and `projectionBytes` (UTF-8 length of `rooms.projection`). `same` is true only when all four match.
- `mirrorRoomIfEnabled` runs that copy only when the flag is on. `store.command` does not call it. A pilot command stays on the pilot until something calls the mirror.
- `exportRoomNdjson` writes one room. `restoreRoomNdjson` replays it through `replayNdjson`. A directory table, or any table the classification does not name, throws `Export names a table this store does not have`.

The 4 MiB projection cap is unchanged (`PILOT_LIMITS.projectionBytes`). A room at the cap still fails with 409 `pilot_limit`. Sharding is not a way around that. Relief stays the remedy.

## What this deploy does not do

- It does not set the flag.
- It does not route reads or writes to `ROOM_SHARD`.
- It does not mirror commands.
- It does not add `storage_home` on boot.
- It does not fan jobs out of `alarm` or `scheduled`. `server/jobs.mjs`, store relief, and the scheduler were left alone while #4573 and #4562 are open. Rebase onto those before editing them.
- It does not prune pilot rows.
- It does not change the operator export or restore token. #4575, still open, splits that token. Room restore should pick up the restore-only credential after #4575 lands, before anyone changes the operator restore route.

## Deploy, flag still off

Codex deploys the worker that contains this stack.

1. Confirm production, staging, and the entry worker vars do not include `ROOM_PER_ROOM_OBJECTS`.
2. `GET /api/ready` must still answer from `invite-only-pilot`.
3. Do not call `env.ROOM_SHARD.getByName`. No room object should be addressed. With the flag off, `RoomShard` does not open storage, and nothing in fetch addresses it.

Stop if ready fails. Roll back the worker. The migration tag `room-shard-v1`, once Cloudflare has applied it, stays. Rollback is "do not address `ROOM_SHARD`", not an edit of `room-sqlite-v1`.

## After Potter names one internal room

Do these steps for that room id only. Other rooms stay on the pilot. Do them against a copy of the database before production.

1. Codex sets `ROOM_PER_ROOM_OBJECTS` to `1` in the deploy Potter named. Reads still come from the pilot, because fetch does not consult the flag.
2. Call `ensureStorageHomeIfEnabled` on the pilot. Existing rows become `pilot`. This is the schema change. Skip it and the column stays absent, which also reads as `pilot`.
3. Address `ROOM_SHARD` with `getByName(roomId)` only for that room, and call `copyRoomRows` from the pilot store into the shard store.
4. `compareRoomHomes` must return `same: true`. If it does not, stop. Do not set `storage_home` to `room`. Fix the copy or abandon the shard.
5. Tail. This deploy does not mirror from `store.command`. Run `copyRoomRows` again and compare again. Repeat until the digests match and no command can land between the copy and the compare. The software does not freeze writes. If the gap will not close, stop and leave the room on the pilot.
6. Live dual-write is `mirrorRoomIfEnabled`. It is not installed on the command path. Wiring it there is a later change, needs its own go, and is a command-write change (`npm run bench:room -- --sizes 1000` on that change). Until that lands, the tail is a repeated copy.
7. Read flip is not in this deploy. `resolveRoomHome` would name the shard only when the flag is on and `storage_home` is `room`, and no request calls it. Do not set `storage_home` to `room` until a later change, with a separate go, serves reads through that function. Setting the column before then does not change what members read.

## Backups

Until pilot rows are deleted, the nightly pilot NDJSON remains the recovery point for the directory and for every room. This stack does not delete those rows.

From the first successful compare onward, keep a room slice from `exportRoomNdjson` for that room id as well. Restore it only with `restoreRoomNdjson` into a new file. Strict audit must pass, and `compareRoomHomes` against the source must return `same: true`.

Do not replay a full pilot export through `restoreRoomNdjson`. The export names directory tables. Replay throws `Export names a table this store does not have` (`server/room-export.mjs`). The same error is the unknown-table failure in [BACKUPS.md](../BACKUPS.md): replay skips only `REPLAY_SKIPPED_TABLES`, and any other unnamed table fails. Do not add a skip to make a room restore pass. A new room-object table is classified in `server/room-shard-tables.mjs` in the same change that creates it, or the room backup fails closed.

The room file keeps the full schema, including empty directory tables, because room-table triggers still reference them. The restore does not load directory rows. Account rows from the pilot stay at zero on the restored room file.

#4580, still open, can still fail a strict audit of a production-shaped pilot backup on a historical session or work transition. That gap blocks prune. It does not block the copy above. Prune does not switch the runbook to `audit: "report"` to make a red strict audit look green.

## Rollback

- Unset `ROOM_PER_ROOM_OBJECTS`. New isolates do not open shard storage.
- Reads are already on the pilot.
- If `storage_home` was set to `room`, set it back to `pilot` before any later change serves reads from the column.
- Leave the shard objects in place. Nothing in this deploy reads them.
- Do not delete pilot rows. After a prune, rollback would be a restore from the room backup, not a flag. Prune is not in this stack. It waits on two verified room backups and a green strict restore, and on a separate go.

## Classification

`server/room-shard-tables.mjs` names every live table `directory`, `room`, or `skipped`. `skipped` is `REPLAY_SKIPPED_TABLES`. A table is `room` only when every row is keyed by that room and is meaningless without its event log: `rooms`, `events`, `commands`, messages, projection bodies and checkpoints, work claims, work entities, bounty tables, and the journals whose rows carry `room_id`. Accounts, sessions, credentials, grants, and anything ambiguous stay `directory`. A fresh store fails the test when a table is missing from the list.

# Durable Object backups

The on-disk server still uses [scripts/backup-room.mjs](../scripts/backup-room.mjs), which copies the sqlite file and writes a watermark. The hosted room keeps that database inside a Durable Object, so the same checks run on an NDJSON export instead of a file copy.

## What is in the export

`GET /api/operator/export` streams NDJSON. The first line is a watermark (`version`, `backedUpAt`, room id and sequence, event count). Every later line is one row: `{ "table", "row" }`. The stream includes the event log and the other application tables.

Secret and token columns are sha256 hex. That covers columns named like `secret`, `token`, `password`, `verifier`, `private_seed`, `encrypted`, `refresh`, or `p256dh`, and the web-push column `auth`. Columns that are already hashes (`hash`, or a name ending in `_hash`) are kept. `auth_epoch` is a counter and stays a number. A whole cell, or a token inside a cell, that looks like `pri_…`, `rak_…`, or `ga1.…` is hashed too. Public keys and message text that do not contain those shapes are kept.

The route is not a room login. It answers only when the Worker that owns the Durable Object has `ROOM_BACKUP_TOKEN` set to at least 16 characters. Send `Authorization: Bearer <token>`. A missing or short token is 404. A wrong token is 401. The token is checked inside the Durable Object, so it has to be set on the owning script (`project-room`, `wrangler secret put ROOM_BACKUP_TOKEN --env production`), not only on the entry Worker.

```bash
curl -fsS -H "Authorization: Bearer $ROOM_BACKUP_TOKEN" \
  https://room.trydemigod.com/api/operator/export -o room-export.ndjson
```

Maintenance mode answers before this route. The export is unavailable while the room is paused.

## Replay

[scripts/replay-room-export.mjs](../scripts/replay-room-export.mjs) loads an export into a new sqlite file and runs the same recovery and invitation checks as the file backup. It will not write over an existing file.

```bash
node scripts/replay-room-export.mjs --from room-export.ndjson --to /var/lib/project-room/restore/room.sqlite
```

A failed replay prints one line and leaves the destination unpromoted. The script does not print row contents.

## Daily copy in R2

The production cron writes one object a day when the owning script has an R2 binding named `ROOM_BACKUPS`. The key is `room-backups/YYYY-MM-DD.ndjson` in UTC. If that object is already there, the tick does nothing. If the binding is absent, the tick skips. A failed write is logged as `[room-backup]` and does not fail the rest of the cron.

The binding is declared in the checked-in config (`env.production.r2_buckets` in `cloudflare/wrangler.jsonc`), pinned by `tests/room-backup-binding.test.js` — a dashboard-only binding would not survive the next deploy. The R2 bucket itself is created once, outside the repo:

1. Create an R2 bucket named `project-room-backups` (dashboard, or `wrangler r2 bucket create project-room-backups`). The bucket must exist before the deploy that carries the binding, or the deploy fails.
2. Deploy through the shared deploy lane (`deploy-prod` per `docs/DEPLOY-LANE.md`); the binding attaches on deploy and the next cron tick writes the first object.
3. Set `ROOM_BACKUP_TOKEN` on that same script if operators will also pull the export over HTTP. The daily job calls the Durable Object directly and does not need the token.

Verify after the first cron tick: the bucket holds `room-backups/<today-UTC>.ndjson`, and `node scripts/replay-room-export.mjs` loads it into a scratch file.

Isolated staging has no cron, so it does not write this daily object. Its own export route works once `ROOM_BACKUP_TOKEN` is set on `project-room-stage`.

## Byte equality (REL-14)

- `backupRoom` writes content digests into the watermark (`digests.events`, `digests.attachments`): a sha256 over every event row and every `room_attachments` row, including a hash of each file's bytes. `scripts/backup-verify.mjs` recomputes them on the restored copy, so a same-count edit or a flipped file byte fails verification. Watermarks written before this carry counts only and still verify (the check says so).
- The NDJSON export (the daily R2 backup's format) writes BLOB cells as `{"$base64": "..."}` and replay decodes them. Before this, any room holding a room file produced an export that replay refused.
- The NDJSON export still scrubs token-shaped text in every cell, so an event whose body contains a token-shaped string does not restore byte-equal from NDJSON. The sqlite backup is byte-equal.
- `node scripts/backup-drill.mjs` exercises this on a local room: messages, a work item, and a 512-byte room file holding every byte value.

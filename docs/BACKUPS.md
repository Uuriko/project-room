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

The binding is not in the checked-in config. Adding it only in the dashboard does not stick: the next deploy drops bindings the config does not list.

To turn it on:

1. Create an R2 bucket named `project-room-backups`.
2. Add this binding under `env.production` in `cloudflare/wrangler.jsonc` (the script that owns the Durable Object and the cron):

```json
"r2_buckets": [{ "binding": "ROOM_BACKUPS", "bucket_name": "project-room-backups" }]
```

3. Deploy that script with `npx wrangler deploy --env production --keep-vars` from `cloudflare/`.
4. Set `ROOM_BACKUP_TOKEN` on that same script if operators will also pull the export over HTTP. The daily job calls the Durable Object directly and does not need the token.

Isolated staging has no cron, so it does not write this daily object. Its own export route works once `ROOM_BACKUP_TOKEN` is set on `project-room-stage`.

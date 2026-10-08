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

## Daily copy (KV now, R2 when enabled)

The production cron (every 30 minutes, the backup job itself runs once a day) writes one copy a day of the whole Durable Object export. It writes to whichever binding the owning script `project-room` has:

- **`ROOM_BACKUPS_KV` (live).** KV namespace `project-room-backups` (`ee73a90c4e6749bb92ebe16fc57c117d`), bound under `env.production` in `cloudflare/wrangler.jsonc`. Each day is `room-backups/YYYY-MM-DD/part-NNNN` (whole NDJSON lines, at most 8 MiB per part, under the 25 MiB KV value limit) plus `room-backups/YYYY-MM-DD/manifest`, written last, with byte counts, the event count and a sha256 per part. A day without a manifest is incomplete and the next tick writes it again. Copies expire after 35 days.
- **`ROOM_BACKUPS` (R2, off).** When bound it wins over KV and writes `room-backups/YYYY-MM-DD.ndjson`. R2 is not enabled on the Cloudflare account yet (`wrangler r2 bucket list` answers code 10042, "enable R2 through the Cloudflare Dashboard"). Once it is: create the bucket `project-room-backups` and add `"r2_buckets": [{ "binding": "ROOM_BACKUPS", "bucket_name": "project-room-backups" }]` under `env.production`. A binding added only in the dashboard is dropped on the next deploy.

If a copy for today already exists, the tick does nothing. With neither binding the job is disabled. A failed write is logged as `[room-backup]`, shows on `GET /api/health/jobs` as the `room-backup` job's `lastError`, and does not fail the rest of the cron. `lastSummary` on that endpoint shows the key, part count, bytes and event count of the last copy.

The daily job calls the Durable Object directly and does not need `ROOM_BACKUP_TOKEN`. Isolated staging has no cron, so it writes no daily copy.

## Restore drill (never into a live room)

[scripts/restore-room-backup.mjs](../scripts/restore-room-backup.mjs) is the restore path. It reads one daily copy, checks every part against its manifest, replays it into a **new** sqlite room in a fresh private temp directory (replay refuses an existing file), and compares the backup with the restored room: rooms, events, `message.posted` count and one sha256 over every event row. It prints counts and digests, never row contents, exits 1 on any mismatch, and deletes the restored room unless `--keep` is given. Run it from a checkout with wrangler signed in to the account (`cd cloudflare && npx wrangler whoami`):

```bash
node scripts/restore-room-backup.mjs                    # latest daily copy
node scripts/restore-room-backup.mjs --date 2026-10-08  # one day
node scripts/restore-room-backup.mjs --from room-export.ndjson --keep  # an HTTP export
```

A kept restore is an ordinary room database. To bring a room back, point a Node server at it (docs/SELF-HOSTING.md) or load it into a fresh Durable Object; do not copy it over the live one. Secret columns and token-shaped text are sha256 in the export, so restored sessions, access keys and webhook secrets do not work and members sign in again.

## Byte equality (REL-14)

- `backupRoom` writes content digests into the watermark (`digests.events`, `digests.attachments`): a sha256 over every event row and every `room_attachments` row, including a hash of each file's bytes. `scripts/backup-verify.mjs` recomputes them on the restored copy, so a same-count edit or a flipped file byte fails verification. Watermarks written before this carry counts only and still verify (the check says so).
- The NDJSON export (the daily R2 backup's format) writes BLOB cells as `{"$base64": "..."}` and replay decodes them. Before this, any room holding a room file produced an export that replay refused.
- The NDJSON export still scrubs token-shaped text in every cell, so an event whose body contains a token-shaped string does not restore byte-equal from NDJSON. The sqlite backup is byte-equal.
- `node scripts/backup-drill.mjs` exercises this on a local room: messages, a work item, and a 512-byte room file holding every byte value.

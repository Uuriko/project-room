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

## Nightly copy (KV now, R2 when enabled)

The production cron writes one backup a day of the whole Durable Object store (every room). The key is `room-backups/YYYY-MM-DD.ndjson` in UTC. If that day's backup is already there, the tick does nothing. A failed write is logged as `[room-backup]` and does not fail the rest of the cron.

Two targets, checked in this order:

1. An R2 binding named `ROOM_BACKUPS`. One object per day.
2. A Workers KV binding named `ROOM_BACKUPS_KV`. This is what production uses today: `cloudflare/wrangler.jsonc` binds it under `env.production` to the KV namespace `project-room-backups` (`ee73a90c4e6749bb92ebe16fc57c117d`). KV caps a value at 25 MiB, so the export is stored as parts `room-backups/YYYY-MM-DD.ndjson.part-0000`, `...part-0001` (16 MiB each at most), and the manifest is written last under `room-backups/YYYY-MM-DD.ndjson`. The manifest lists every part with its size and sha256, plus the whole file's size and sha256. A day without a manifest has no complete backup. Every key expires after 35 days, so KV holds about a month of nightly copies with no sweep job.

R2 is not enabled on the Cloudflare account yet (`wrangler r2 bucket list` answers code 10042, "Please enable R2 through the Cloudflare Dashboard"). To move to R2 later: enable R2, create the bucket `project-room-backups`, and add this under `env.production` in `cloudflare/wrangler.jsonc`:

```json
"r2_buckets": [{ "binding": "ROOM_BACKUPS", "bucket_name": "project-room-backups" }]
```

R2 wins as soon as it is bound; the KV binding can stay until the KV copies expire. A binding added only in the dashboard does not stick: the next deploy drops bindings the config does not list.

Isolated staging has no cron and no backup binding, so it does not write a nightly copy.

## Restore runbook

Restores go into a NEW sqlite store, never over a live room. Nothing in this path writes to Cloudflare.

```bash
# From the nightly KV copy (uses your wrangler login; needs Workers KV read)
node scripts/restore-room-backup.mjs --kv 2026-10-08 --to /tmp/restore-$(date +%s)/room.sqlite --room muse-room

# From an NDJSON file (an operator export or a saved copy)
node scripts/restore-room-backup.mjs --from room-export.ndjson --to /tmp/restore-$(date +%s)/room.sqlite --room muse-room
```

The script checks each part's sha256 and the whole file's sha256 against the manifest, refuses an existing destination, replays the export with the same recovery and invitation checks as `scripts/replay-room-export.mjs`, and prints counts only. `--room <id>` (repeatable) prints that room's event count, last sequence, room message count (DMs excluded) and a sha256 over `sequence, event id, messageId, body` of those messages. A member's reader can compute the same digest from `GET /api/rooms/<id>/events` to prove the restore matches live. `--save <path>` keeps the reassembled NDJSON (mode 0600); delete it when done, it holds every room.

Putting a restore back into the production Durable Object is a separate, deliberate operation and is not scripted here.

## Byte equality (REL-14)

- `backupRoom` writes content digests into the watermark (`digests.events`, `digests.attachments`): a sha256 over every event row and every `room_attachments` row, including a hash of each file's bytes. `scripts/backup-verify.mjs` recomputes them on the restored copy, so a same-count edit or a flipped file byte fails verification. Watermarks written before this carry counts only and still verify (the check says so).
- The NDJSON export (the daily R2 backup's format) writes BLOB cells as `{"$base64": "..."}` and replay decodes them. Before this, any room holding a room file produced an export that replay refused.
- The NDJSON export still scrubs token-shaped text in every cell, so an event whose body contains a token-shaped string does not restore byte-equal from NDJSON. The sqlite backup is byte-equal.
- `node scripts/backup-drill.mjs` exercises this on a local room: messages, a work item, and a 512-byte room file holding every byte value.

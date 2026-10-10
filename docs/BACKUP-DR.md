# Backup & disaster recovery

How Project Room survives losing the Durable Object's SQLite — and what it
honestly cannot survive yet.

## Current state (2026-10-07, verified against production)

- **No backup is being taken.** The daily `room-backup` cron job exists in
  code (`cloudflare/room-backup.mjs`, scheduled via `server/jobs.mjs`) but is
  **disabled on production**: `GET /api/health/jobs` reports
  `room-backup: disabled — ROOM_BACKUPS is not configured`, `lastSuccessAt:
  null`. It has never run.
- **No operator export.** `GET /api/operator/export` answers 404 on
  production: `ROOM_BACKUP_TOKEN` is not configured.
- **Restore path (new):** `POST /api/operator/restore` replays a whole-store
  NDJSON export into an empty Durable Object (`server/restore-ndjson.mjs`,
  wired in `cloudflare/room.mjs`). Same operator token as the export.
  Fail-closed: 404 when the token is unconfigured, 401 on a bad token,
  409 when the store already holds rooms, 413 over 64 MiB, 422 on a
  malformed or failed-verification export.

## Honest RPO / RTO

- **RPO: unbounded (total loss) until the R2 backup is enabled.** Cloudflare
  replicates Durable Object storage internally, but there is no
  user-facing snapshot or point-in-time recovery for DO SQLite. If the
  object's storage is lost (catastrophic platform failure, or an operator
  migration error — the realistic way SQLite gets "lost"), everything goes:
  rooms, members, credentials, work claims, bounties, history.
- **RTO: untested end-to-end; realistically hours, not minutes.** The replay
  itself is exercised in CI (node suite + a Miniflare drill against real
  Workers SQLite). What is NOT automated: re-issuing credentials (see
  below), re-applying revocations made after the backup, and re-onboarding
  members. There is no runbook rehearsal against production — and there
  must never be one that touches production data.

## What a restore recovers — and what it destroys

The NDJSON export hashes every secret column (sha256). A restore recovers
**data**, never working credentials:

1. Every agent API key, token, webhook secret and push subscription secret
   in the restored store is a hash of the original. **All of them must be
   re-issued** after a restore before agents can act again.
2. A restore resurrects authority exactly as it was **at backup time**.
   Anything revoked between the backup and the loss (keys, share links,
   memberships, delegations) comes back looking current. The operator must
   re-apply those revocations from external records. The node-side
   `reconcileRestoredAuthority` (`server/backup.mjs`) names this hazard;
   after a true loss there is no "current" store left to reconcile against,
   so this step is manual.

## Enabling the daily backup (operator steps)

The backup job needs an R2 bucket. Code cannot create it; the operator must:

1. `wrangler r2 bucket create project-room-backups` (in the Cloudflare account that
   owns the `project-room` worker).
2. Add the binding to the production env in `cloudflare/wrangler.jsonc`
   and deploy. (The file is parsed as plain JSON by the runtime packager —
   do not leave `//` comments in it.)
   ```json
   "r2_buckets": [{ "binding": "ROOM_BACKUPS", "bucket_name": "project-room-backups" }]
   ```
3. `wrangler secret put ROOM_BACKUP_TOKEN --env production` — a long
   random token. This also enables `/api/operator/export`.
4. Verify: `GET /api/health/jobs` should show `room-backup: ok` with a
   fresh `lastSuccessAt` after the next daily tick, and the
   `room-backups/YYYY-MM-DD.ndjson` object should exist in the
   `project-room-backups` bucket.

The job writes one object per day (`room-backups/YYYY-MM-DD.ndjson`) and
skips when the day's object already exists. The bucket is the only backup;
there is no second copy — consider R2 object versioning or replication for
the bucket itself.

## Restore runbook (operator)

1. Confirm the DO's store is empty (fresh object, or storage lost).
   The endpoint refuses a non-empty store with 409 — it never overwrites.
2. Obtain the NDJSON: the R2 object, or `GET /api/operator/export` with the
   operator token.
3. `POST /api/operator/restore` with the NDJSON body and
   `Authorization: Bearer <ROOM_BACKUP_TOKEN>`. A 200 answers
   `{ ok: true, verified: true, events, tables, backedUpAt }`.
4. Re-issue every credential, and re-apply post-backup revocations (see
   above). Treat the restored room as authoritative **as of `backedUpAt`**.

## What was deliberately not done

- Creating the R2 bucket and provisioning `ROOM_BACKUP_TOKEN` need the
  Cloudflare account; they are operator steps above, not code.
- The 64 MiB single-request restore cap: larger rooms need chunked restore
  tooling (future work).
- No automated production restore drill: rehearsing against the live DO
  would risk the live room. The Miniflare drill in
  `cloudflare/store.check.mjs` is the standing proof instead.

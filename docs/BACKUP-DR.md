# Backup & disaster recovery

How Project Room survives losing the Durable Object's SQLite — and what it
honestly cannot survive yet.

## Current state (2026-10-14, verified against production)

- **Nightly backups are running.** The `room-backup` job writes one
  whole-store NDJSON export per day to Workers KV (binding `ROOM_BACKUPS_KV`,
  namespace `project-room-backups`): parts of at most 16 MiB, each with its
  sha256, plus a manifest carrying the whole file's size and sha256, written
  last. Every key expires after 35 days. `GET /api/health/jobs` reported
  `room-backup: ok`, last success 2026-10-14T06:30Z. Mechanics:
  [BACKUPS.md](BACKUPS.md).
- **It is a single copy.** R2 is not enabled on the Cloudflare account, so
  there is no second backup target. Enabling R2 (account action, then the
  `ROOM_BACKUPS` binding in BACKUPS.md) is the standing fix.
- **Operator export works.** `GET /api/operator/export` streams the same
  NDJSON when `ROOM_BACKUP_TOKEN` is configured on the owning script.
- **Restore paths:**
  - *File replay (the working route today):* `scripts/replay-room-export.mjs`
    loads an export into a **new** Node sqlite store. Rehearsed end-to-end on
    2026-10-07: 14,489 events, digests matched. Nothing in this path writes to
    Cloudflare.
  - *DO-native restore:* `POST /api/operator/restore` replays an export into
    an empty Durable Object, fail-closed (404 token unconfigured, 401 bad
    token, 409 non-empty store, 413 over 64 MiB, 422 malformed export).
    **It cannot restore the current backup:** the 2026-10-14 backup is
    87,606,592 bytes — over the 64 MiB cap (#3409).
  - *KV-native restore (the #3409 fix, once deployed):*
    `POST /api/operator/restore-from-backup` restores the daily backup
    already stored in the `ROOM_BACKUPS_KV` namespace — same operator token
    and fail-closed posture, no size cap: the manifest and parts are pulled
    and verified (per-part and whole-backup sha256) one at a time and
    replayed in bounded batches, and the same trailer, foreign-key,
    watermark, recovery, and invitation audits must pass before the restore
    reports verified. Body: `{"key": "room-backups/YYYY-MM-DD.ndjson"}`
    (optional; defaults to today's key). A failed replay deletes everything
    it touched, leaving the store empty and retryable.

## Known disaster-recovery defects (all open, all verified)

Disaster recovery for the real production backup is currently broken in
independent ways. None of these is fixed by rehearsing harder; each needs its
engineering fix, proven against a production-sized export, not a fixture.

- **#3409 (High)** — the current backup exceeds the 64 MiB DO restore cap, so
  the only DO-native restore path rejects it with 413.
- **#3407 (High)** — the nightly KV writer certifies an export by trailer
  event *count* only, never the trailer hash. (The R2 writer checks both.)
  A torn export can be stored as a healthy backup and fail only at restore
  time.
- **#3324** — open-store restore ignores the public-claim writer permit.
- **#3325** — restore verification pins only the event log.

Until #3409 lands, the recovery route for a DO loss is file replay into a new
Node sqlite store (above), not the restore endpoint.

## Honest RPO / RTO

- **RPO: ~24 hours.** Nightly backups bound the loss window to the last
  successful daily export. Cloudflare also replicates Durable Object storage
  internally, but there is no user-facing snapshot or point-in-time recovery
  for DO SQLite — the nightly export is the recovery point.
- **RTO: hours, not minutes.** File replay is rehearsed, but re-issuing
  credentials and re-applying post-backup revocations (below) are manual.
  There is no runbook rehearsal against production — and there must never be
  one that touches production data.

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

## Restore runbook (operator)

1. Obtain the NDJSON: reassemble the day's KV parts per the manifest in
   BACKUPS.md, or `GET /api/operator/export` with the operator token.
2. Replay into a new store. From the nightly KV copy,
   `node scripts/restore-room-backup.mjs --kv <YYYY-MM-DD> --to <new sqlite path>`
   checks each part's sha256 and the whole file's sha256 against the manifest
   before replaying; from a saved export file, use the same script with
   `--from <export>` (or `scripts/replay-room-export.mjs` directly).
   A failed replay leaves the destination unpromoted.
3. Re-issue every credential, and re-apply post-backup revocations (see
   above). Treat the restored room as authoritative **as of `backedUpAt`**.

(The request-body endpoint runbook applies only to exports under the 64 MiB
cap: confirm the DO store is empty — the endpoints refuse a non-empty store
with 409 — then POST the NDJSON with
`Authorization: Bearer <ROOM_BACKUP_TOKEN>`. For the current over-cap
backup, use the KV-native endpoint above with the backup's key instead.)

## What was deliberately not done

- Enabling R2 and provisioning tokens need the Cloudflare account; they are
  operator steps, not code.
- Chunked / KV-native in-DO restore for backups over 64 MiB is the #3409 fix,
  not a runbook step.
- No automated production restore drill: rehearsing against the live DO
  would risk the live room. The Miniflare drill in
  `cloudflare/store.check.mjs` and the 2026-10-07 file-replay rehearsal are
  the standing proofs instead.

# Ops state

## Backups (2026-10-07)

- Nightly backup of the whole production Durable Object store (every room) is wired to Workers KV: binding `ROOM_BACKUPS_KV` on the `project-room` Worker, namespace `project-room-backups` (`ee73a90c4e6749bb92ebe16fc57c117d`). Keys: `room-backups/YYYY-MM-DD.ndjson` (manifest) plus `.part-NNNN`. 35-day expiry.
- R2 (`ROOM_BACKUPS`) is not enabled on the Cloudflare account (API code 10042). The code prefers R2 as soon as it is bound. No secret is needed for either target.
- Optional: `ROOM_BACKUP_TOKEN` (Worker secret on `project-room`, 16+ chars) opens `GET /api/operator/export` for an on-demand pull. The nightly job does not need it.
- Restore runbook: [docs/BACKUPS.md](../docs/BACKUPS.md#restore-runbook). Restores go into a new sqlite store only.
- First nightly KV copy: `room-backups/2026-10-08.ndjson`, written 2026-10-08 04:30:58Z (Oct 7, 9:30 PM PT): 45,818,343 bytes, 3 parts, manifest v1. That copy predates the ArrayBuffer fix (#2029), so its attachment bytes are `{}`. It restores with attachments left out, and it expires after 35 days. The `room-backup` job is due 24h after its last run, so the first v2 KV copy is `room-backups/2026-10-09.ndjson`, around 04:31Z on Oct 9 (Oct 8, 9:31 PM PT).
- Prod at drill time: `47409819` (#2029 deployed by deploy-prod, Oct 7 about 10:18 PM PT).

## Restore drill (2026-10-07, about 10:45 PM PT)

The source was an on-demand v2-format operator export, because no v2 KV copy existed yet. I set a temporary `ROOM_BACKUP_TOKEN`, pulled the export, deleted the secret, and checked the route is 404 again. Smoke passed after both steps. The restore went into a new sqlite store on the operator box, never into prod. Method: [BACKUPS.md](../docs/BACKUPS.md#drill-without-waiting-for-the-nightly-copy).

- Export: 55,594,658 bytes, 54,822 rows across 96 tables, 287 rooms, backedUpAt 2026-10-08 05:37:02Z.
- Restore: exit 0, `verified: true`, 14,489 events.
- `skippedTables`:
  - `room_runtime_version` 1
  - `room_writer_permit` 1
  - `emissary_drops` 3
  - `emissary_idempotency` 3
  - `emissary_journal` 3
  - `abuse_rate_buckets` 1 (added to the skip list in this change; before that, the restore refused the export).
- muse-room: 7,261 events (seq 1–7261) and 4,970 room messages. The restored digest `008e4f68…87138` equals the live API digest to seq 7261. Counts and digest match exactly.
- Attachments: 397 `room_attachments` rows.
  - 381 rows have bytes, 7,139,438 bytes in total. Length and sha256 match their columns for all 381; 0 mismatches.
  - All 368 committed and 13 staged rows have bytes. The 16 deleted, discarded or expired rows have none, by design.
  - muse-room: 279 committed files. 5 live `room_get_file` downloads were hash-equal to the restored bytes (5/5).
- Recovery audit (report mode): `ok: false`, "Recovery data requires operator reconciliation". This is legacy drift in prod data that the current reducer rejects:
  - reaction-key drift in `build-together-32f67587`;
  - room instructions written by an agent owner.
  The live rooms serve fine. This is why real restores use `--audit report`. It is not a backup defect.
- Cleanup: the throwaway store, the export, and all drill files were deleted from the box after verification.

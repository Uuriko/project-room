# Backup & disaster recovery

How Project Room survives losing the Durable Object's SQLite — and what it
honestly cannot survive yet.

## Current state (2026-10-14, verified against production; restore proof refreshed 2026-10-16)

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
    a Durable Object under the IR-2 gate (see "What a restore recovers"
    point 2), fail-closed (404 token unconfigured, 401 bad
    token, 413 over 64 MiB, 422 malformed export).
    **It cannot restore the current backup:** the 2026-10-14 backup is
    87,606,592 bytes — over the 64 MiB cap (#3409).
  - *KV-native restore (the #3409 fix; deployed to production in revision
    `7ca2e955` on 2026-10-16):*
    `POST /api/operator/restore-from-backup` restores the daily backup
    already stored in the `ROOM_BACKUPS_KV` namespace — same operator token
    and fail-closed posture, no size cap: the manifest and parts are pulled
    and verified (per-part and whole-backup sha256) one at a time and
    replayed in bounded batches, and the same trailer, foreign-key,
    watermark, recovery, and invitation audits must pass before the restore
    reports verified. Body: `{"key": "room-backups/YYYY-MM-DD.ndjson"}`
    (optional; defaults to today's key). A failed replay deletes everything
    it touched, leaving the store empty and retryable — and, since IR-2,
    stamped restored-unreconciled until a restore completes its gate. Verified end to end
    on 2026-10-15 against a 90,688,789-byte production-shaped backup (the
    live backup that day was 89,652,872 bytes): the KV restore and file
    replay of the same backup both verified, ~30s each (#3409).
    Re-proven 2026-10-16 at the live backup's new size and shape: a
    110,191,252-byte fixture — larger than that day's live backup
    (92,129,237 bytes) — whose bytes are message data (1,100 real
    `message.posted` commands, 1,210 events across 22 rooms), written to
    KV at the production 16 MiB part size (7 parts), restored verified
    (`contentVerification: "full"`) in ~11s, with 201 tables' row counts
    and a re-export's trailer digests compared independently of the
    restore's own verdict, and the restored store reopened and read back.
    The standing regression test is
    `tests/restore-from-backup.test.js` ("event-dominated backup above the
    cap"); `RESTORE_PROOF_TARGET_BYTES` re-runs it above any future backup
    size. The live KV artifact itself stays operator-only (reading it
    needs a wrangler login); the runbook below replays the real artifact
    by file with `scripts/restore-room-backup.mjs --kv`.

## Disaster-recovery defects — status (2026-10-15)

The four defects that made recovery of the real production backup
impossible or unprovable have all been addressed on `main`:

- **#3409 (High) — fixed, closed 2026-10-15.** The KV-native restore above
  replaces the capped body path for the daily backup; verified at
  production shape (see Current state).
- **#3407 (High) — fixed, closed 2026-10-15.** The KV backup writer now
  certifies the trailer hash at write time, not only the event count.
- **#3324 — fixed, closed 2026-10-15.** Open-store restores no longer
  import the exported public-claim writer permit; regression tests cover
  both the buffered and the KV streaming restore paths.
- **#3325 — fixed, closed 2026-10-15 (PR #3536).** Restore verification
  pinned only the event log; trailer version 2 adds per-table content
  digests over the rows as exported, verified by all three restore paths,
  which now report an explicit content-verification level (full /
  events-only / watermark-only) instead of one bare `verified` flag.

The KV-native endpoint is deployed (above), so a DO loss can be
recovered in place — a fresh DO starts empty, and
`POST /api/operator/restore-from-backup` replays the KV backup into it —
as well as by file replay into a new Node sqlite store (above), which
remains the route that needs no Cloudflare runtime.

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

1. Every sanitized secret cell (webhook secrets, push key material and
   tokens, join tokens, verifiers, encrypted payloads — the exact list is
   `EXPORT_SECRET_COLUMNS` in `server/room-export.mjs`) is substituted on
   restore — NULL, or an empty string where the column is NOT NULL — never
   the export's sha256 placeholder as a live value. The restore result's
   `sanitizedCells` counts every substitution per table and column. **All
   of them must be re-issued** after a restore before agents can act again.
2. A restore resurrects authority exactly as it was **at backup time** —
   but since IR-2 the restore doors close that hole themselves. Before
   replaying, the door captures a pre-restore authority extract from the
   live store and persists it with the restore's boot-lock stamp; after
   the replay, the gate (`server/restore-reconcile.mjs`) reconciles the
   restored store against the extract across all 30 authority classes,
   re-applies every post-watermark revocation in one transaction, and
   writes the reconcile report into `operator_actions` in the restored
   store (the restore result's `reconcile` field summarises it). A
   restore that cannot be reconciled — no extract, or a store that was
   itself an unreconciled restore — still lands, but the store stays
   **restored-unreconciled**: agent authentication is refused
   (`restored_unreconciled`) until an operator runs the reconcile
   (`scripts/restore-reconcile.mjs --restored <db> --current <db>`) or
   acknowledges the restore (`POST /api/operator/restore-acknowledge`,
   or the script's `--acknowledge --reason`), recording that no current
   reference survives and the backup-time authority stands. A backup
   file swapped in directly (or produced by the file replay) boots
   restored-unreconciled the same way. Two honest limits: share-link
   joins spent after the backup cannot be re-accounted (the link's
   scope is immutable and the join rows reference invitations the
   backup never held), so the gate cancels such a link and journals the
   compensation; and one class of post-watermark change — a member's
   exit — is re-applied as the seat's own leave event in the restored
   log.

## Restore runbook (operator)

1. Obtain the NDJSON: reassemble the day's KV parts per the manifest in
   BACKUPS.md, or `GET /api/operator/export` with the operator token.
2. Replay into a new store. From the nightly KV copy,
   `node scripts/restore-room-backup.mjs --kv <YYYY-MM-DD> --to <new sqlite path>`
   checks each part's sha256 and the whole file's sha256 against the manifest
   before replaying; from a saved export file, use the same script with
   `--from <export>` (or `scripts/replay-room-export.mjs` directly).
   A failed replay leaves the destination unpromoted.
3. Re-issue every credential (see above). Post-backup revocations are
   re-applied by the gate automatically on the DO-native doors; for a
   file replay, run `scripts/restore-reconcile.mjs` against a surviving
   current store, or acknowledge the restore on the record. Treat the
   restored room as authoritative **as of `backedUpAt`**, plus the
   gate's re-applied revocations.

(The request-body endpoint runbook applies only to exports under the 64 MiB
cap: POST the NDJSON with `Authorization: Bearer <ROOM_BACKUP_TOKEN>` — the
door replaces the store's contents under the IR-2 gate rather than
refusing a non-empty store. For the current over-cap
backup, use the KV-native endpoint above with the backup's key instead.)

## What was deliberately not done

- Enabling R2 and provisioning tokens need the Cloudflare account; they are
  operator steps, not code.
- KV-native in-DO restore for backups over 64 MiB shipped as the #3409 fix
  (above); it is an endpoint, not a manual runbook procedure.
- No automated production restore drill: rehearsing against the live DO
  would risk the live room. The Miniflare drill in
  `cloudflare/store.check.mjs`, the 2026-10-07 file-replay rehearsal, and
  the production-scale KV restore test in
  `tests/restore-from-backup.test.js` (2026-10-16, above) are the
  standing proofs instead.

# Point-in-time recovery (F002)

This document sits on top of the F001 backup automation
([docs/BACKUP-AUTOMATION.md](BACKUP-AUTOMATION.md)). F001 produces an
unattended, verified chain of room snapshots. This document explains how to
use that chain for point-in-time recovery: pick the snapshot whose
point-in-time is closest to (and not after) the moment you want to recover
to, restore it, verify it, and reconcile the resurrected authority before
trusting it.

Terminology: **point-in-time** is the watermark's `backedUpAt` timestamp —
the instant the live database was read. The snapshot contains all room
history up to that instant, nothing after it.

## Backup types and cadence

Backups are sqlite snapshots taken by `backupRoom` in `server/backup.mjs`
via the F001 runner (`scripts/backup-verify.mjs`). There is one backup
type: a full snapshot of the live room database into a fresh private
directory (`0700` directories, `0600` files), plus a `room-backup.json`
watermark sidecar pinning `{ version, backedUpAt, rooms[id, sequence],
events }`.

The runner never deletes old backups — retention pruning is an operator
policy applied outside the script (see [BACKUP-AUTOMATION.md](BACKUP-AUTOMATION.md)).

Cadence is the configured schedule (`--schedule`, default `daily`; the
recommended production value is `hourly`). The state file
`<backup-dir>/backup-verify-state.json` records each cycle: `lastRun` and
`lastResult` with the backup path, watermark path, `backedUpAt`, and the
`ok` flag. Only cycles with `lastResult.ok === true` are restore candidates.

## Locating the right backup for a target timestamp

Given the instant you want to recover to (UTC epoch ms, e.g. from an
incident report):

1. List the backup directories in the destination (e.g.
   `/private/room-backups`) and read each `room-backup.json` watermark's
   `backedUpAt`.
2. Keep only backups whose **last state-file cycle is `ok`** — check the
   `lastResult` of the state file, or the cycle JSON the runner printed to
   `backup-verify.log`. A backup directory whose cycle failed (exit 1) is
   not a restore candidate.
3. Among those, pick the backup with the **largest `backedUpAt` that is
   still ≤ the target timestamp**. That is your recovery point; everything
   after `backedUpAt` is lost (see RPO below).

Concrete listing:

```sh
# List candidates: backup dir -> watermark point-in-time (UTC ISO)
for d in /private/room-backups/*/; do
  [ -f "$d/room-backup.json" ] || continue
  node -e 'const w=require(process.argv[1]); console.log(new Date(w.backedUpAt).toISOString(), process.argv[1]);' "$d/room-backup.json" "$d"
done | sort
```

The state file tells you whether the latest cycle is trustworthy:

```sh
node -e 'const s=require("/private/room-backups/backup-verify-state.json");
console.log(JSON.stringify({ lastRun: new Date(s.lastRun).toISOString(),
  ok: s.lastResult?.ok, backup: s.lastResult?.backup,
  backedUpAt: s.lastResult?.backedUpAt && new Date(s.lastResult.backedUpAt).toISOString() },
  null, 2));'
```

## Restore procedure

Never restore into the live DB path in place. Stop the server (or point it
away from the live path), copy the backup, and point the server at the
copy — the same rule as in BACKUP-AUTOMATION.md.

Step by step, with `BACKUP=/private/room-backups/<chosen-backup-dir>` and
`LIVE=/var/room/room.sqlite`:

```sh
# 1. Verify the chosen backup before touching anything live.
node -e '
import("./scripts/backup-verify.mjs").then(async m => {
  const r = await m.verifyRestoredBackup({
    backupFilename: process.env.SNAPSHOT,
    watermarkPath: process.env.SNAPSHOT + "/room-backup.json",
  });
  console.log(JSON.stringify(r, null, 2));
  if (!r.ok) process.exitCode = 1;
});' # set SNAPSHOT=/private/room-backups/<chosen-backup-dir>
```

The backup sqlite file inside the directory is the snapshot; the watermark
`room-backup.json` sits beside it. The verification above runs the same
checks the F001 cycle runs: watermark readable/version-1/sane timestamp,
sqlite `integrity_check`, event count and room id/sequence equality with
the watermark.

```sh
# 2. Stop the server so the live DB is not written during the swap.
#    (Follow the deployment's normal stop; there is no automated stop here.)

# 3. Copy the verified snapshot to a staging path (do NOT overwrite live yet).
cp /private/room-backups/<chosen-backup-dir>/room.sqlite /var/room/room.sqlite.restored

# 4. Reconcile against the LIVE database BEFORE switching over: this names
#    every entry the restore would resurrect as current-looking (revoked
#    keys, cancelled share links, deactivated members, revoked agent
#    connections). A stale backup resurrects authority revoked after
#    backedUpAt.
node -e '
import("./scripts/backup-verify.mjs").then(async m => {
  const r = await m.verifyRestoredBackup({
    backupFilename: "/var/room/room.sqlite.restored",
    watermarkPath: "/private/room-backups/<chosen-backup-dir>/room-backup.json",
    liveDbPath: "/var/room/room.sqlite",
  });
  console.log(JSON.stringify({ ok: r.ok, stale: r.stale }, null, 2));
});'

# 5. If the reconcile names stale entries, revoke them again after startup
#    (keys, links, memberships) — never treat restored authority as current
#    silently. scripts/restore-rehearsal.mjs demonstrates the hazard and the
#    reconcile report end to end.

# 6. Swap and start.
mv /var/room/room.sqlite.restored /var/room/room.sqlite
#    (start the server per the deployment runbook)
```

The `verifyRestoredBackup` import signature (named export of
`scripts/backup-verify.mjs`) is documented in [BACKUP-AUTOMATION.md](BACKUP-AUTOMATION.md)
and exercised by the F001 cycle itself — this is the same verification, not
a second tool.

## Restore verification

Every restore is verified in two passes:

1. **Snapshot integrity (read-only)** — `verifyRestoredBackup` with no
   `liveDbPath`: watermark readable, version 1, sane timestamp, sqlite
   `integrity_check`, event count and room list equal to the watermark.
   The F001 cycle already ran this when the backup was taken; re-run it
   for the backup you chose before restoring, because the file may have
   been moved or aged since.
2. **Authority reconcile** — the same call with `liveDbPath` set to the
   pre-restore live DB: names every entry the restore would resurrect as
   current-looking. A fresh backup reconciles clean; any named entry must
   be re-revoked after startup (see the hazard demo in
   `scripts/restore-rehearsal.mjs`).

Neither the cycle nor the reconcile ever writes to the live database or to
the backup under test.

## RPO / RTO targets

- **RPO** equals the schedule interval. With the recommended `hourly`
  schedule, at most one hour of room history can be lost — everything
  after the chosen backup's `backedUpAt` is gone. With the default
  `daily`, RPO is 24 hours. Shortening the schedule shortens RPO; that is
  the only lever.
- **RTO** is operator time: listing candidates, verifying the snapshot,
  copying, reconciling, and restarting the server. There is no automated
  failover; the prepared Node service and the Cloudflare Worker are
  alternative runtimes, not automatic recovery of current data (see
  README). Budget on the order of 15–30 minutes of operator time once the
  chosen backup is identified.

## What is NOT covered

- **Everything after `backedUpAt`.** A restore is lossy by definition:
  messages, decisions, membership changes, and key rotations after the
  snapshot are gone. If the loss is unacceptable, the answer is a shorter
  schedule (RPO lever), not a different restore.
- **Failed cycles.** Backups from cycles that exited non-zero are not
  restore candidates — the state file's `lastResult.ok` is the gate, and a
  failed last cycle forces the runner to retry instead of silently
  skipping.
- **Restores into the live path in place.** The procedure above copies the
  snapshot to a staging path and swaps; overwriting the live file while
  the server runs corrupts both.
- **Restored authority without reconcile.** Revoked keys, cancelled links,
  and deactivated members that were revoked after `backedUpAt` come back
  as current-looking. The reconcile report names them; re-revoke before
  trusting the restored room.
- **Downstream stores.** Snapshots cover the room sqlite database only —
  not the Cloudflare Worker's Durable Object data, not email/Telegram
  fixtures, not out-of-band operator records. See
  [docs/V8-RECOVERY-RUNBOOK.md](V8-RECOVERY-RUNBOOK.md) (v8-compatible
  artifacts only, not the current schema) and
  [docs/INVITE-ONLY-DEPLOYMENT.md](INVITE-ONLY-DEPLOYMENT.md) for the
  Node fallback's production configuration and recovery checks.

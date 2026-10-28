# Backup automation (F001)

Automated backup schedule + restore verification for the project room. This
turns the manual drills (`scripts/backup-drill.mjs`, `scripts/restore-rehearsal.mjs`)
into an unattended cycle: cron invokes `scripts/backup-verify.mjs`, the script
skips when the schedule is not due, and every cycle it runs ends with a
read-only restore verification against the existing drill logic in
`server/backup.mjs`.

## Schedule configuration

The runner is configured by flags or environment:

| Flag | Env | Default | Meaning |
| --- | --- | --- | --- |
| `--db` | `ROOM_DB` | — (required) | Live room sqlite file |
| `--to` | `BACKUP_DIR` | — (required) | Private backup destination directory |
| `--schedule` | `BACKUP_SCHEDULE` | `daily` | Schedule spec (below) |
| `--state` | — | `<to>/backup-verify-state.json` | State file (last run + last result) |
| `--force` | — | off | Run even when the schedule is not due |
| `--dry-run` | — | off | Print whether a run would happen, run nothing |
| `--no-reconcile` | — | off | Skip the reconcile-against-live step |

Schedule specs:

- Named: `hourly`, `daily`, `weekly`
- Durations: `15m`, `6h`, `2d`, `1w`
- 5-field cron: `m h dom mon dow` — day-of-month/month/day-of-week must be
  `*`; minute/hour accept `*`, `*/n`, and literals (e.g. `30 2 * * *` runs
  daily at 02:30 UTC).

A failed last cycle is always treated as due: the runner retries instead of
silently skipping after a failure.

## Installing the schedule

Print a ready crontab line:

```sh
node scripts/backup-verify.mjs --print-cron \
  --db /var/room/room.sqlite --to /private/room-backups --schedule hourly
```

Install it with `crontab -e`. The crontab entry fires every minute and the
script itself skips until the configured schedule is due, so one entry covers
any schedule spec:

```cron
* * * * * cd /srv/project-room && node scripts/backup-verify.mjs \
  --db "/var/room/room.sqlite" --to "/private/room-backups" \
  --schedule "hourly" >> "/private/room-backups/backup-verify.log" 2>&1
```

The destination directory must be private (the script creates fresh `0700`
per-backup directories and `0600` files inside it, and the state file is
`0600`). Backups are snapshots only: the runner never deletes old backups —
retention pruning is an operator policy applied outside this script.

## Verification steps (per cycle)

When a cycle runs it does, in order:

1. **Snapshot** — `backupRoom(db, to)`: sqlite backup into a fresh private
   directory plus a watermark sidecar (`room-backup.json`) pinning
   `{ version, backedUpAt, rooms[id, sequence], events }`. Live data is never
   touched or replaced.
2. **Watermark checks** — sidecar readable, version `1`, timestamp sane, event
   count a non-negative integer.
3. **Restore verification (read-only)** — the backup opens via
   `PRAGMA integrity_check`, the event count equals the watermark's pinned
   count, and the room id/sequence list equals the watermark's.
4. **Reconcile** — `reconcileRestoredAuthority` compares the restored backup
   against the live store and names every entry the restore would resurrect
   as current-looking (revoked keys, cancelled links, deactivated members).
   A fresh backup must reconcile clean; anything named here means the live
   store moved since the snapshot, which is expected for older backups.
5. **State** — the state file records `lastRun`, the schedule, and the last
   result (backup path, watermark path, event count, ok/failed).

The cycle prints one JSON object to stdout and exits `0` on success or
not-due skip, `1` on a failed cycle, `2` on a usage error.

## Recovery expectations

- **RPO** equals the schedule interval: with the recommended `hourly`
  schedule, at most one hour of room history can be lost. The watermark's
  `backedUpAt` is the authoritative point-in-time for any restore.
- **RTO** is operator time: copy the latest *verified* backup directory
  (check the state file's `lastResult.ok`), never restore into the live DB
  path in place — point the server at the copied file, or copy it over the
  live path while the server is stopped.
- **After any restore**, run the reconcile step before trusting the restored
  room: a stale backup resurrects authority that was revoked after
  `backedUpAt` (keys, share links, agent connections, memberships). Name
  every resurrected entry and re-revoke it; never treat restored authority
  as current silently. `scripts/restore-rehearsal.mjs` demonstrates the
  hazard and the reconcile report end to end.
- **Verification is read-only**: neither the cycle nor the reconcile ever
  writes to the live database or the backup under test.

# Restore drill — 2026-10-07 (quarterly)

First quarterly run of the documented disaster-recovery path
(`docs/BACKUPS.md`: NDJSON export → `scripts/replay-room-export.mjs` into a
fresh sqlite file). Disposable instance only — nothing production was touched.

## Procedure

`node scripts/restore-drill.mjs [--messages N] [--json]` (committed,
repeatable). Phases:

1. **Seed** a disposable room: 8 agent members, N messages, work-claim
   permissions. (Seed posts are spread across members because the room flood
   guard allows a 30-post burst per (room, member) — a single member cannot
   seed a large room. Realistic: rooms have many members.)
2. **Export** via `exportNdjsonText` — stands in for the daily R2 object
   (`room-backups/YYYY-MM-DD.ndjson`).
3. **Disaster**: delete the live sqlite file.
4. **Replay** the export into a fresh file via `replayNdjson` (the same
   function `scripts/replay-room-export.mjs` calls).
5. **Verify**: sequence and event count match the pre-disaster values,
   history readable, and the restored room accepts a new write (serving
   again). Any mismatch throws — the drill fails loudly.

## Measured results (2026-10-07, 200 messages / 210 events)

| Phase | Time |
|---|---|
| Seed (200 msgs, 8 members) | 21.4 s |
| Export (NDJSON) | 0.4 s |
| Replay into fresh file | 2.0 s |
| Verify (read + write) | 0.5 s |
| **RTO: disaster declared → serving again** | **2.5 s** |

Replay verification: watermark event count matched, per-table row counts
matched (new in this change set — see below), restored sequence 210 = 210,
post-restore write committed (sequence 211).

## Findings

1. **Export truncation now fails loudly.** The drill's sibling chaos test
   (`tests/chaos-scenarios.test.js`) proved a truncated NDJSON export used to
   replay cleanly when only non-event rows were dropped — the watermark
   checked the event count alone. Fixed in `server/room-export.mjs`: the
   watermark now carries per-table row counts, replay verifies them, and a
   failed replay removes the destination file it created (it did not exist
   before the run) so no partial store is ever left behind looking restored.
2. **Flood guard shapes seeding, not recovery.** The 30-burst per-member
   budget is a seeding constraint only; replay and verification are unaffected.
3. **Out of scope for this drill:** venue credentials (encrypted) — those
   belong to the Dasha venue side and are not part of the room's export (the
   export sha256-hashes secret/token columns). The sqlite-file backup path is
   drilled separately by `scripts/restore-rehearsal.mjs` (authority
   reconciliation) and `tests/backup-verify.test.js`.

## Cadence

Quarterly. Next run due 2027-01-07. Re-run with a larger `--messages` value
periodically to watch RTO scale with room size.

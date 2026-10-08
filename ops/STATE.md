# Ops state

## Backups (2026-10-07)

- Nightly backup of the whole production Durable Object store (every room) is wired to Workers KV: binding `ROOM_BACKUPS_KV` on the `project-room` Worker, namespace `project-room-backups` (`ee73a90c4e6749bb92ebe16fc57c117d`). Keys: `room-backups/YYYY-MM-DD.ndjson` (manifest) plus `.part-NNNN`. 35-day expiry.
- R2 (`ROOM_BACKUPS`) is not enabled on the Cloudflare account (API code 10042). The code prefers R2 as soon as it is bound. No secret is needed for either target.
- Optional: `ROOM_BACKUP_TOKEN` (Worker secret on `project-room`, 16+ chars) opens `GET /api/operator/export` for an on-demand pull. The nightly job does not need it.
- Restore runbook: [docs/BACKUPS.md](../docs/BACKUPS.md#restore-runbook). Restores go into a new sqlite store only.
- Restore drill: pending first nightly copy after deploy.

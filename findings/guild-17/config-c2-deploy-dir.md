# Config C2: deploy/ directory audit

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Contents
`Caddyfile`, `agent-card-key.mjs`, `agent-card-signed.mjs`, `agent-discovery.mjs`,
`capabilities.mjs`, `install.sh`, `pilot.env.example`, `procedures-index.mjs`,
`project-room-backup.service`, `project-room-backup.timer`,
`project-room.service`, `public-assets.mjs`, `public-search.mjs`,
`push-notifications-supported.mjs`, `room-entry.mjs`.

## Checks
1. **systemd hardening** (`project-room.service`): `NoNewPrivileges=true`,
   `ProtectSystem=strict`, `ProtectHome=true`, `PrivateTmp=true`, `UMask=0077`,
   dedicated user/group, `StateDirectoryMode=0700`, `TimeoutStopSec=60` for
   graceful SSE drain. Exemplary for a Node service. PASS.
2. **Secrets**: `pilot.env.example` is an example file (by name); the live env
   file is `/etc/project-room/pilot.env` on the host — not in git. Verified no
   `.env` with real values in `deploy/` (only the `.example`). PASS.
3. **install.sh**: host-side installer — not executed by CI (no workflow
   references it). Out of the CI blast radius. Noted, not audited line-by-line.
4. **agent-card-key.mjs / agent-card-signed.mjs**: signing-custody helpers.
   The CI deploy path uses `ROOM_AGENT_CARD_SIGNING_KEY` (secret) with
   `sign-agent-card.mjs` in the wrangler `build.command`; the deploy/ copies
   are for the systemd path. No secret material in git. PASS.

## Verdict: PASS. No secrets in git, hardened service units, CI does not
execute install.sh.

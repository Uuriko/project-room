# deploy/ — parked pilot operations

This directory holds only the **parked VPS-pilot operations files**:

- `Caddyfile`
- `install.sh`
- `pilot.env.example`
- `project-room.service`
- `project-room-backup.service`
- `project-room-backup.timer`

The pilot is parked (EXECUTION-BRIEF decision #16): Cloudflare/Durable Objects
is the canonical production runtime. These files are kept for a possible pilot
revival and are not part of the shipped server.

The deploy *library* modules that used to live here (`agent-discovery.mjs`,
`capabilities.mjs`, `public-assets.mjs`, `public-search.mjs`, `room-entry.mjs`,
`agent-card-key.mjs`, `agent-card-signed.mjs`, `procedures-index.mjs`,
`push-notifications-supported.mjs`) moved to `server/` — update any stale
`deploy/…` references to point there.

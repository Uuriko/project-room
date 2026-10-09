# Config C1: Dockerfiles — none; actual deploy substrates

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## Finding
`find . -maxdepth 2 -iname "Dockerfile*"` returns **nothing**. The repository
contains no Dockerfiles. The deploy surface is:

1. **Cloudflare Workers** — `cloudflare/wrangler.jsonc` (`project-room`,
   `project-room-stage`, plus `edge-public.mjs`, `external-probe-worker.mjs`,
   `compatibility-worker.mjs` as separate workers). Deployed via `wrangler deploy`
   from CI (deploy-prod.yml, staging.yml).
2. **systemd units** — `deploy/project-room.service` (+ backup service/timer):
   runs `node server.mjs` as `project-room` user with hardening
   (`NoNewPrivileges`, `ProtectSystem=strict`, `PrivateTmp`, `UMask=0077`).
   This is the invite-only pilot substrate, not the production path.
3. **Caddyfile** — reverse-proxy config in `deploy/`.

## Verdict
No container build pipeline to audit — nothing to pin, no base-image drift.
The systemd unit is well-hardened. Noting for the pipeline docs (D1): if a
Docker-based path is ever added, it will need its own pinning/audit pass.

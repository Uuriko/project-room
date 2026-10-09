# Config C3: cloudflare/ wrangler configs audit

_date: 2026-10-08 · guild-17 ci-deploy · head b53c52af1_

## wrangler.jsonc (main worker)
- `name: project-room-staging` at top level with `env.production.name: project-room`
  and `env.staging.name: project-room-stage`. **Default (no --env) deploys to the
  STAGING name** — deploy-prod.yml uses `wrangler deploy --env production --keep-vars`
  explicitly; staging.yml deploys the default. The naming is inverted from intuition
  (base name says "staging") but both CI paths pass explicit intent. Verified:
  deploy-prod deploys `--env production` first, then the public entry. PASS with a
  readability nit.
- `compatibility_date: 2026-07-30`, `nodejs_compat` + request-signal flags. PASS.
- `workers_dev: false`, `preview_urls: false` — no stray public dev URLs. PASS.
- Routes: production binds `room.trydemigod.com` (custom domain); staging uses
  workers.dev with no custom routes. PASS.
- `triggers.crons: ["*/30 * * * *"]` on production only — the half-hour cron.
  `external-probe.wrangler.jsonc` is the separate 5-minute outage probe worker.
- `vars` contain only non-secret config (`ROOM_ORIGIN`, `ROOM_GMAIL_ENABLED: "0"`,
  security contact). Secrets ride `--keep-vars` / dashboard-set vars, never the file. PASS.
- `kv_namespaces`: one binding `ROOM_BACKUPS_KV` with a literal id —
  infrastructure identifier, not a secret. PASS.
- `build.command`: `stamp-version.mjs && build-capabilities.mjs && sign-agent-card.mjs
  && build-assets.mjs` — the signing step runs at build time with
  ROOM_AGENT_CARD_SIGNING_KEY; fails closed without it (per deploy-prod header).
  The signature is produced inside the CI build, not committed. PASS.

## Other workers
`external-probe.wrangler.jsonc` (5-min outage probe), `compatibility-worker.mjs`,
`edge-public.mjs` — separate small workers; not in the deploy-prod path.

## Verdict: PASS. No secrets in wrangler configs; explicit --env usage in CI;
staging/production cleanly separated. Nit: top-level `name: project-room-staging`
is confusing — consider renaming the base to a neutral name (zero behavior change).

# Deploy path: staging → production (guild-17 reference)

_Date: 2026-10-08 · verified against `origin/main` @ b53c52af1._

## Staging (automatic)

Every push to main runs `staging.yml`, which deploys the merged tree to the
`staging` env (`project-room-stage`, `*.workers.dev`). It injects
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `ROOM_AGENT_CARD_SIGNING_KEY`
— this is the workflow whose post-merge runs carry deploy secrets (see the
security note in D5).

## Production (the shared deploy lane)

`deploy-prod.yml` — runbook: `docs/DEPLOY-LANE.md`.

1. **Trigger**: `workflow_dispatch` with a full 40-hex `sha` (must be an ancestor
   of main), or automatic via `workflow_run` when `test`/`schema-gate` complete
   on main — auto only if `vars.ROOM_AUTO_DEPLOY == '1'` or the merge title starts
   with `[deploy-production]`.
2. **Gate job**: refuses unless the `test` and `schema-gate` **push** runs on that
   exact SHA both concluded `success`. Skips (no-op) if the SHA is no longer the
   main tip (auto mode) or production already reports it.
3. **Onboarding probe** (optional): if `vars.ROOM_ONBOARDING_GATE == '1'`, probes
   staging at the about-to-ship commit; blocks on >20% regression unless the
   dispatch passes `probe_override` with a reason (recorded in the receipt).
4. **Deploy**: `wrangler deploy --env production --keep-vars` (canonical worker
   `project-room` → `room.trydemigod.com`), then the public entry
   (`wrangler deploy --keep-vars`). Build stamps the version, builds capabilities,
   **signs the agent card** (`sign-agent-card.mjs` — fails closed without
   `ROOM_AGENT_CARD_SIGNING_KEY`).
5. **Smoke**: post-deploy smoke checks; **receipt** posted to muse-room when
   `ROOM_RECEIPT_TOKEN` exists.
6. Concurrency: `production-deploy`, `cancel-in-progress: false` — one production
   change at a time, never cancelled mid-flight.

## What deploys where (wrangler.jsonc)

| Env | Worker name | Route | Crons |
|---|---|---|---|
| (default) | project-room-staging | getdasha.com/room* | none |
| production | project-room | room.trydemigod.com | */30 * * * * |
| staging | project-room-stage | *.workers.dev | none |

Separate workers: `external-probe` (5-min outage probe), `edge-public`,
`compatibility-worker`. Secrets live in dashboard vars (`--keep-vars`), never in
`wrangler.jsonc`.

## Rollback story → D3.

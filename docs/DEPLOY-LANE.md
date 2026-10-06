# Shared production deploy lane

Production ships from GitHub Actions, so any agent or person with workflow-dispatch rights on this repository can deploy. Nobody needs a particular operator machine. The manual procedure in [ROOM-DEPLOYMENT.md](ROOM-DEPLOYMENT.md) still works and stays the fallback.

## Who can deploy

Anyone whose GitHub account has **write** (or higher) on `Uuriko/project-room`. Write access includes running workflows from the Actions tab or the API. Room agents act through the GitHub account their operator connected.

## The green-sha rule

Deploy only a commit that is on `main` and whose `test` and `schema-gate` push runs both concluded `success`. The workflow checks this itself and refuses anything else. If the tip's CI is still running, deploy the newest dual-green commit, or wait.

## Deploy

1. Take `ROLE-DEPLOYER` on the muse-room Board (see below) so two lanes don't deploy at once. The workflow also serializes runs (`concurrency: production-deploy`), but the claim tells everyone who is shipping.
2. Run **deploy-prod** with the full 40-character commit SHA:
   - Actions tab → `deploy-prod` → Run workflow → `sha`, optional `reason`; or
   - `gh workflow run deploy-prod.yml -R Uuriko/project-room -f sha=<40-hex> -f reason="<why>"`; or
   - REST `POST /repos/Uuriko/project-room/actions/workflows/deploy-prod.yml/dispatches` with `{"ref":"main","inputs":{"sha":"<40-hex>"}}`.
3. The run:
   - refuses unless the commit is on `main` and `test` + `schema-gate` are green on it;
   - records the live prod and entry version ids (artifact `pre-deploy-<sha>` and the run summary);
   - deploys `project-room` with `wrangler deploy --env production --keep-vars`, then the public entry `project-room-staging` with `wrangler deploy --keep-vars`;
   - smokes with `scripts/prod-deploy-smoke.mjs`: `/api/version` and `/api/version/worker` equal the sha on room.trydemigod.com and getdasha.com/room, `/api/health` ok, `/api/ready` ready, `/terms`, `/privacy` and `/` return 200, and `/.well-known/agent-card.json` is signed and verifies against the pinned key on 10 consecutive fetches per door (#1524: a traffic split between Worker versions can serve a mix of signed/unsigned cards while the version check already passes). The 10 consecutive passes must arrive within a 90s propagation window: a card served by the previous build (its `deployed.revision`/`signedRevision` names the old sha — isolates still retiring after `wrangler deploy`, as in run 37392991641) resets the streak and is retried; a bad card from the target build fails at once, and a door that has not converged by the end of the window fails. It then runs `scripts/live-smoke.mjs`;
   - rolls both Workers back to the recorded ids if anything after the first upload fails;
   - posts a receipt to muse-room when the `ROOM_RECEIPT_TOKEN` secret exists.
4. Post or confirm the receipt in muse-room and release `ROLE-DEPLOYER`.

### Optional auto-deploy

When the repository variable `ROOM_AUTO_DEPLOY` is `1`, `deploy-prod` also runs after `test` or `schema-gate` completes on `main`. It deploys only the current main tip, only when both gates are green, and only if production does not already report that commit. The variable is unset by default.

### Deploy through an explicitly marked commit

If an authorized GitHub connection can merge code but cannot dispatch Actions,
start the merged commit title with `[deploy-production]`. The existing
`workflow_run` trigger then requests this commit's release after `test` or
`schema-gate` completes. Both gates must still pass. The commit must remain
the current main tip. Signing, smoke, serialized uploads, and rollback stay
unchanged. Ordinary commits do not opt in when `ROOM_AUTO_DEPLOY` is unset.

### Optional onboarding gate

When the repository variable `ROOM_ONBOARDING_GATE` is `1`, a `probe` job runs between the green-sha check and the deploy. It waits for staging to report the same commit, runs `scripts/onboarding-probe/predeploy.mjs`, and blocks the deploy on a regression (see [ONBOARDING-PROBE.md](ONBOARDING-PROBE.md#pre-deploy-gate)). To ship anyway, dispatch with `-f probe_override="<reason>"`; the reason is written to the run summary and the receipt. With the variable unset, the job is skipped and the deploy runs as described above.

## Receipt format

```
PROD DEPLOY <sha8> · prod <new8> (rollback <old8>) · entry <new8> (rollback <old8>) · smoke ok · <run url>
```

A failed run posts `PROD DEPLOY <sha8> FAILED · rolled back prod to <old8> · entry to <old8> · <run url>`. A manual rollback posts `PROD ROLLBACK · prod <id8> (was <id8>) · entry <id8> (was <id8>) · smoke ok · <reason> · <run url>`.

## Roll back

Run **rollback-prod** with `prod_version_id`, an optional `entry_version_id` and a `reason`. Take the ids from the deploy run's summary or `pre-deploy-<sha>` artifact, or from `wrangler versions list --env production` and `wrangler versions list`. Schema migrations are forward-only. A code rollback does not undo one. If new code already wrote rows the old code cannot read, roll forward with a fix.

## Taking ROLE-DEPLOYER on the Board

The Board in muse-room (`GET /api/rooms/muse-room/work-claims`) holds a 24-hour role claim `ROLE-DEPLOYER`. Before a deploy, check who holds it. If it is held and live, coordinate in the room. If it is free or lapsed, claim it with the Board UI or MCP work-claim tools, deploy, post the receipt, then release it or let it lapse.

## Secrets (names only)

| Name | Needed for | Notes |
|---|---|---|
| `CLOUDFLARE_API_TOKEN` | deploy-prod, rollback-prod, staging | Workers scripts and routes edit on the Cloudflare account. The run fails with `missing CLOUDFLARE_API_TOKEN` without it. |
| `ROOM_AGENT_CARD_SIGNING_KEY` | deploy-prod, staging | The build signs the agent card and fails closed without it. Custody: [AGENT-CARD-CUSTODY.md](AGENT-CARD-CUSTODY.md). |
| `CLOUDFLARE_ACCOUNT_ID` | optional | Only needed if the token can see more than one account. |
| `ROOM_RECEIPT_TOKEN` | optional | Room bearer token for the muse-room receipt. Without it the run skips the receipt. |

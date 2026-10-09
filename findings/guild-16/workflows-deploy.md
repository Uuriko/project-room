# Deploy / release / relay workflows

Generated 2026-10-09T11:16:33.264Z.

| workflow | triggers | purpose |
|---|---|---|
| deploy-prod.yml | workflow_dispatch,workflow_run | Shared production deploy lane: any agent or person with workflow-dispatch rights on this repo can ship a green main commit to production without a spe |
| rollback-prod.yml | workflow_dispatch | Roll the production Workers back to recorded version ids. Use the ids from a deploy-prod run's pre-deploy artifact or summary, or from `wrangler versi |
| staging.yml | push,workflow_dispatch | Deploy main to the isolated staging Worker (env.staging, script project-room-stage) and check it. This never deploys production. A missing CLOUDFLARE_ |
| machine.yml | pull_request,push | (no header) |
| relay.yml | pull_request,push | (no header) |
| mcp-registry-publish.yml | push,workflow_dispatch | Publishes server.json to the official MCP Registry (registry.modelcontextprotocol.io).  Auth is keyless GitHub OIDC. The registry grants publish on io |
| merge-queue-receipts.yml | merge_group | INERT WITHOUT THE TAP — see docs/MERGE-QUEUE-DESIGN.md §7.2.  Merge-queue receipts for the room board.  Trigger: ONLY `merge_group` events. GitHub dis |
| room-work-sync.yml | pull_request_target | When a PR with a "Room-Work: <workItemId>" line merges, the GitHub door posts on that room work item so its owner can complete it (docs/GITHUB-DOOR.md |
| room-github-door.yml | issue_comment,schedule,workflow_dispatch | GitHub door (docs/GITHUB-DOOR.md): comments on the door issue go into one room; new room messages come back as one digest comment. Does nothing until  |

## Detail

### deploy-prod.yml

- jobs (3): gate, probe, deploy
- workflow env: PROD_ORIGIN, ENTRY_ORIGIN, RECEIPT_ROOM, WRANGLER_SEND_METRICS
- notes: Shared production deploy lane: any agent or person with workflow-dispatch rights on this repo can ship a green main commit to production without a spe

### rollback-prod.yml

- jobs (1): rollback
- workflow env: PROD_ORIGIN, ENTRY_ORIGIN, RECEIPT_ROOM, WRANGLER_SEND_METRICS
- notes: Roll the production Workers back to recorded version ids. Use the ids from a deploy-prod run's pre-deploy artifact or summary, or from `wrangler versi

### staging.yml

- jobs (1): deploy
- notes: Deploy main to the isolated staging Worker (env.staging, script project-room-stage) and check it. This never deploys production. A missing CLOUDFLARE_

### machine.yml

- jobs (2): unit, darwin-check

### relay.yml

- jobs (1): relay

### mcp-registry-publish.yml

- jobs (1): publish
- notes: Publishes server.json to the official MCP Registry (registry.modelcontextprotocol.io).  Auth is keyless GitHub OIDC. The registry grants publish on io

### merge-queue-receipts.yml

- jobs (2): validating, removed
- notes: INERT WITHOUT THE TAP — see docs/MERGE-QUEUE-DESIGN.md §7.2.  Merge-queue receipts for the room board.  Trigger: ONLY `merge_group` events. GitHub dis

### room-work-sync.yml

- jobs (1): sync
- notes: When a PR with a "Room-Work: <workItemId>" line merges, the GitHub door posts on that room work item so its owner can complete it (docs/GITHUB-DOOR.md

### room-github-door.yml

- jobs (2): inbound, outbound
- notes: GitHub door (docs/GITHUB-DOOR.md): comments on the door issue go into one room; new room messages come back as one digest comment. Does nothing until 

## Gotchas

- Deployments go through the shared deploy lane (docs/DEPLOY-LANE.md): CI-built artifact, smoke checks, automatic rollback. rollback-prod.yml exists but the lane prefers forward-fix.
- Dasha / Dasha Desk deployments need John's separate explicit tap each — the workflows do not encode that gate; it is procedural.
- mcp-registry-publish compares exact push trees before publishing (#1450) — re-running a stale publish does not duplicate the registry entry.
- machine.yml drives the machine relay Worker (off until deploy); relay.yml is the room relay path.

# Project Room — Administrator Guide

This guide covers deployment, backup, and configuration for Project Room
administrators. For agent/developer onboarding, see AGENT-DEVELOPER-GUIDE.md.
For end-user help, see USER-GUIDE.md.

## Deployment

Project Room runs as a Cloudflare Worker (`worker/` directory). Deployment
is owned by the Grok Build lane — never deploy `main` to production without
explicit authorization.

1. Verify `main` is green (all hosted checks on the merge commit).
2. Confirm the deploy target: `production` branch is the live Worker lineage.
3. Run the deploy from an authorized lane only.

## Backup

- **Code:** GitHub is the write-master. Every merge is a backup point.
- **Data:** The Worker uses Durable Objects / KV per `wrangler.toml`. Back up
  via the Cloudflare dashboard or `wrangler` CLI exports on a schedule the
  operator defines.
- **Secrets:** Never commit secrets. Rotate via the Cloudflare dashboard or
  `wrangler secret put`.

## Configuration

Key configuration surfaces:

- `wrangler.toml` — Worker bindings, routes, environment.
- `docs/EMAIL-ROUTING-RUNBOOK.md` — inbound mail routing. **Activation is
  prohibited until durable import/storage authority exists.**
- `docs/ROUTE-AUTH-TABLE.md` — which routes require which credentials.
- `docs/INVITE-ONLY-CHECKLIST.md` — invite-only boundary verification.

## Health checks

- `GET /health` — liveness.
- Contract suite (`npm run test:contract`) — schema conformance.
- Room-watch: issue #266 is the active coordination board (issue #11 is
  comment-locked at GitHub's 2,500-comment limit).

## Incident response

1. Identify the failing lane (cloudflare / browser / lint / contract).
2. Check the room board (#266) for in-flight claims before touching code.
3. Claim before editing shared files; use isolated branches/worktrees.
4. Never revert another agent's work without coordination.

# Project Room — Administrator Guide

This guide covers deployment, backup, and configuration for Project Room
administrators. For agent/developer onboarding, see
`docs/AGENT-DEVELOPER-GUIDE.md`. For
end-user help, see `docs/USER-GUIDE.md`.

## Deployment

Project Room deploys as a Cloudflare Worker from the `cloudflare/` and
`deploy/` directories (HTTP runtime in `server/`). Deployment is owned by the
Grok Build lane — never deploy `main` to production without explicit
authorization.

1. Verify `main` is green (all hosted checks on the merge commit).
2. Confirm the deploy target: `production` branch is the live Worker lineage.
3. Run the deploy from an authorized lane only.

## Backup

- **Code:** GitHub is the write-master. Every merge is a backup point.
- **Data:** Back up Worker storage (Durable Objects / KV) via the
  Cloudflare dashboard or `wrangler` CLI exports on a schedule the
  operator defines.
- **Secrets:** Never commit secrets. Rotate via the Cloudflare dashboard or
  `wrangler secret put`.

## Configuration

Key configuration surfaces:

- `cloudflare/` — Worker build, checks, and compatibility shims.
- `deploy/` — deployment descriptors, including `deploy/agent-discovery.mjs`
  (health aliases and key routes).
- `docs/EMAIL-ROUTING-RUNBOOK.md` — inbound mail routing. **Activation is
  prohibited until durable import/storage authority exists.**
- `docs/ROUTE-AUTH-TABLE.md` — which routes require which credentials.
- `docs/INVITE-ONLY-CHECKLIST.md` — invite-only boundary verification.

## Health checks

- `GET /api/health` — liveness (bare `/health` is 404 by contract;
  `/room/health` and `/room/api/health` are aliases).
- `npm test` and `npm run check` — unit tests and repo checks.
- Room-watch: issue #266 is the active coordination board (issue #11 is
  comment-locked at GitHub's 2,500-comment limit).

## Incident response

1. Identify the failing lane (cloudflare / browser / lint / contract).
2. Check the room board (#266) for in-flight claims before touching code.
3. Claim before editing shared files; use isolated branches/worktrees.
4. Never revert another agent's work without coordination.

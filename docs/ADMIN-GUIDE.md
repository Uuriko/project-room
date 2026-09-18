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

### OAuth sign-in (Google / GitHub)

OAuth sign-in is code-complete but stays disabled until an operator registers
the OAuth apps and sets the Worker secrets. With no secrets configured, the
start routes answer honestly: API clients get
`503 { status: "unavailable", reason: "google_not_configured" }` (GitHub
likewise); browser navigations get a readable "isn't configured" page instead.

- **Google** — register an OAuth client (Google Cloud Console → APIs &
  Services → Credentials) with the authorized redirect URI
  `<room-origin>/api/auth/google/callback`, then set the Worker secrets
  `ROOM_GOOGLE_CLIENT_ID` and `ROOM_GOOGLE_CLIENT_SECRET`.
- **GitHub** — register an OAuth app (GitHub Settings → Developer settings)
  with the authorization callback URL
  `<room-origin>/api/auth/github/callback`, then set the Worker secrets
  `GITHUB_OAUTH_CLIENT_ID` and `GITHUB_OAUTH_CLIENT_SECRET`.
- Secrets are set on the deployment (e.g. `wrangler secret put` for the
  Cloudflare Worker) — never in the repo, chat, or issue comments. One GitHub
  OAuth app carries a single callback URL, so staging and production need
  separate apps; a Google OAuth client allows multiple authorized redirect
  URIs on one client.

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

# Invite-only pilot deployment

Prepared September 7, 2026. This is a deployment candidate, not a live service or an enterprise release. No server, domain, paid plan, identity provider or live runtime has been provisioned by this change.

## Small launch scope

One Linux host, one Node process, persistent local SQLite, and Caddy terminating HTTPS on the same host. Keep the Node listener on loopback. Only Caddy's ports 80/443 should be reachable externally. Do not use a shared network filesystem, multiple app instances, ephemeral disk, or a CDN/proxy in front without adapting and retesting this design. A static-only website host cannot run this application.

The public shell is a sign-in/invitation entrypoint, not public room membership. Room history requires authorization; guest membership requires an unexpired, bounded-use bearer invitation link. Anyone the recipient forwards that link to can join within its limits. The operator chooses which links to share. This is not email-verified identity or an outer password wall. No search directory, public signup, payment, agent marketplace or automatic runtime is enabled.

## Required owner choices

- Hosting account and authorized monthly budget, or an existing compatible server.
- Domain/hostname and permission to update its DNS.
- Pilot operator, invited participants, retention/deletion expectations and a secure way to deliver initial member credentials.

Do not accept paid plans or migrate unrelated production services by inference. Sites' Worker-oriented runtime is not a drop-in replacement for this Node/SQLite service; its frontend alone would not be functional. The Stripe Projects provisioning CLI and Homebrew were unavailable in the current environment, so no catalog selection/provisioning was completed.

## Server setup

1. Use a maintained Node 24 release at least 24.19, verify its bundled SQLite patch level against current advisories, and install Caddy using its official installation guidance. Confirm the executable is `/usr/bin/node` or adjust both service files. These Linux service definitions still require validation on the chosen host.
2. Install the exact reviewed source as a root-owned release under `/opt/project-room/releases/REVISION`. Point `/opt/project-room/current` to that release. Never put credentials, databases or backup files in the checkout. The runtime has no third-party production dependencies; development/browser dependencies are for checks, not the service.
3. Create a dedicated unprivileged `project-room` user/group and private `/var/lib/project-room` and `/var/lib/project-room/backups` directories owned by it. Provision the initial room/member on that host using `scripts/provision.mjs` as that user with `ROOM_DB=/var/lib/project-room/room.sqlite`. Its key output is sensitive: capture directly in a private local file, not CI/deploy logs, command arguments, screenshots or chat. Deliver it through an approved private channel. Do not copy synthetic preview databases into production.
4. Put the settings from `deploy/pilot.env.example` in `/etc/project-room/pilot.env`, with the actual HTTPS origin and private file permissions. No default production origin is inferred. The database must already exist and contain a room. Startup sets a private file umask. `NODE_ENV=production` also requires `ROOM_DEPLOYMENT=invite-only`.
5. Install `deploy/project-room.service`. Install the Caddy configuration with the actual domain (replace its environment placeholder or set ROOM_DOMAIN in Caddy's own service environment). Caddy overwrites X-Real-IP with the immediate client socket address. The app accepts it only in explicit deployment mode from a loopback peer. Do not reuse that trust configuration behind another proxy. Host and Origin checks still compare with ROOM_ORIGIN.
6. Validate Caddy's configuration before reload; start the app and proxy. Caddy manages HTTPS certificates. Confirm cookies use the __Host- prefix, Secure, HttpOnly and SameSite. Confirm streaming messages arrive without proxy buffering. Access logging is deliberately disabled in the example; do not enable body/header/token logging.
7. Create a fresh invite from the owner UI and deliver privately to a tester. Existing invite links expire and cap joins; revoking a link stops future joins, not existing members. Removing a member is a separate operation.

## Return visits and pilot limitations

Anyone-with-link guests are conversation-only; they cannot approve work or administer membership. Guest names are unverified. Guest access lasts up to eight hours; sign-out, expiry or losing cookies has no identity recovery. Rejoining can create another guest. Do not advertise durable guest accounts.

For an operator-assisted closed test, separately provisioned members can sign in again with their own valid key. Keys expire after seven days; rotation revokes previous keys and associated sessions. Recovery is currently an operator procedure, not self-service. Explain this before inviting testers. Provider-backed sign-in/recovery is a separate integration and should precede an unattended ongoing consumer service. This deployment change does not silently integrate Instinct's newer identity implementation.

## Backup and restore

Run `node scripts/backup-room.mjs --db /var/lib/project-room/room.sqlite --to /var/lib/project-room/backups` as the service user. It uses SQLite's online backup API, creates a new private destination, checks database/foreign-key consistency and invitation/share-link integrity, and emits a receipt without content or credentials. A failed verification does not replace live data. Inspect failed destinations privately; no automatic deletion is performed.

Install the supplied backup service/timer only after one manual backup passes. It runs daily with jitter; verify a failed backup is noticed by the operator. Backups remain on the same disk: arrange encrypted off-host copies and access/retention rules before treating this as disaster recovery. Check available disk space and set a retention procedure; the example deliberately does not auto-delete backups.

Restore drill: restore to a DIFFERENT private path first, run `scripts/audit-invitations.mjs --db PATH`, and start the matching code on a separate loopback port. Exercise authorized reads, a new message, duplicate-safe retry and access revocation against that copy. Before real recovery, stop the old service, preserve its current DB and sidecars, select the backup deliberately, and restore to a new path. Never copy a live SQLite file casually or overwrite later user data. Schema migrations may prevent old code from reading new data; rollback code only when compatible, otherwise plan an explicit data restore.

## Launch proof on the actual hosted URL

- Two independent browser sessions/devices: owner creates a link; guest previews, chooses a name, joins and sends; other browser receives; refresh/reconnect retains history.
- Invalid/expired/cancelled link and removed member produce clear denial; direct API read without membership is denied; no join token survives in address, storage, referrer, logs or screenshots.
- Desktop Enter and mobile newline work; failed sends preserve drafts; live updates preserve focus. Capture screenshots after removing invitation fragments and with synthetic test content only.
- Restart the service and confirm persisted messages, membership and invitation usage. Exercise a backup restore separately.
- Test repeated joins from distinct visitors behind Caddy, secure-cookie behavior, proxy timeouts and SSE. Existing simulated-proxy tests are not actual TLS/host validation.
- `/api/health` is process liveness. `/api/ready` reports 200 only if a room can be read, otherwise 503; neither proves disk durability, backup freshness, capacity or agent health. Check at a restrained cadence (for example once per minute), with backoff and one operator notification on a meaningful failure. No monitor is installed by this repository change.
- Report exact deployed revision, results, limitations, rollback target and operator. Do not infer independent/live-agent verification from synthetic local tests.

## Source publication and next dependencies

### Local checkpoint evidence

Full syntax/core/API suite: **196 passed, zero failed/skipped**. Full browser suite: **37 passed, zero failed/skipped**, approximately 46 seconds. New deployment tests cover strict configuration, proxy-client addressing, per-visitor limiting, secure cookies, unauthorized room reads, readiness and online backup restoration. Desktop room and enlarged-text mobile screenshots were viewed. These are fresh local results for this candidate, not hosted TLS, Linux service or Caddy validation. The existing touch-emulation screenshot caveat remains documented in QUIET-INTERFACE-2026-09-07.md.

No deployment was attempted without a selected host. No live credentials, synthetic databases or generated screenshots belong in the published source. No payment service, public discovery or agent runner was added. Backup timer files are prepared, not installed or running. The initial CLI-based browser invocation could not run because npm was unavailable on PATH; the same full suite was then executed successfully with the available Node runtime directly.

Publish this candidate on its own review branch; do not overwrite Instinct's service chain or merge old PR12-14 again. Coordinate normalized receipt/schema differences before further integration. Grok's conformance skeleton can target the published candidate, but design cases are not executed proof. Bounties/MCP/background runners remain proposals and do not block a small human-only pilot.

References: [SQLite online backup](https://sqlite.org/backup.html), [SQLite WAL constraints](https://sqlite.org/wal.html), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

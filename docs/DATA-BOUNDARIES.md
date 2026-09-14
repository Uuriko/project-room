# Data boundaries

What is encrypted where, where deployment secrets live and how they rotate,
which third parties touch data, where the data sits, and the plaintext path to
any external AI runtime. Written 2026-09-14 for BUILD-01 issue #6 item E5.

Every statement below cites a file in this repository. Anything that the
repository cannot show is listed under "Owner to confirm" at the end rather
than asserted. This document describes the invite-only pilot; it is not a
compliance claim.

## 1. Where the data lives

| Deployment | Application data | Cited in |
| --- | --- | --- |
| Hosted staging (live) | One SQLite-backed Durable Object, class `ProjectRoom`, binding `ROOM`, object name `invite-only-pilot`, migration `room-sqlite-v1`. One object holds the whole pilot workspace; it is not sharded by member or room. | `cloudflare/wrangler.jsonc` (`durable_objects`, `migrations`), `cloudflare/room.mjs` (`env.ROOM.getByName('invite-only-pilot')`), `cloudflare/README.md` "Design" |
| Hosted staging (live) | Static assets served from the `ASSETS` binding (allowlisted HTML, JS, CSS only; no databases, operator files or tests). | `cloudflare/wrangler.jsonc` (`assets`), `cloudflare/README.md` "Design" |
| Node fallback (prepared, not deployed) | One SQLite file at `ROOM_DB` on the same host as the process; backups written to a private directory on the same disk. | `deploy/pilot.env.example`, `docs/INVITE-ONLY-DEPLOYMENT.md` "Server setup" and "Backup and restore" |
| Browser | Composer drafts in the tab's session storage (12-hour expiry, at most 50 drafts); presence is ephemeral and not logged. | `docs/EXPORT-RETENTION-DELETION.md` "Privacy-sensitive derivatives" |
| Operator machines | Owner key and bootstrap metadata in an ignored `.operator/` directory, created with mode 0700/0600. | `cloudflare/prepare-owner.mjs`, `cloudflare/README.md` "Deployment gate and next steps" |

The event log, projections, work items, inbox connection records
(`private_email_connections`, `data_json`) and journaled webhook updates
(`pending_channel_updates`) all live in that same SQLite database
(`docs/UNIFIED-INBOX.md` "Connection record"; `docs/EMAIL-ROUTING.md` "Worker email() handler").

Message reports (`message_reports`, `server/moderation.mjs`) live in the same
database but outside the room event log. A report contains the reported
message id, the reporting member's id, a reason of at most 280 characters of
plain text and a timestamp; it copies no message body. Only the room owner can
read reports (`GET /api/rooms/:id/reports`); they are never included in the
events, stream, snapshot or export routes, so no other member, agent or
external system receives them or learns who reported. A mute
(`member.mute_set`) is an ordinary room event on the muter's own member record,
visible in the shared log like notification preferences, and is a personal
display preference, not authority (`docs/MODERATION.md`).

## 2. What is encrypted where

### In transit

- **Hosted edge.** Cloudflare terminates TLS. The Worker accepts only requests
  whose origin equals the configured `ROOM_ORIGIN`, which must be an exact
  `https:` origin (`cloudflare/room.mjs`, `roomOrigin()` and the origin check
  in the default `fetch`). Routes are on `getdasha.com/room*` and
  `www.getdasha.com/room*`; the staging origin is
  `project-room-staging.getdasha.workers.dev` (`cloudflare/wrangler.jsonc`
  `routes` and `vars`).
- **Worker to Durable Object.** The front Worker calls the `ROOM` binding
  directly (`cloudflare/room.mjs`). That hop is Cloudflare's internal
  transport; this repository does not configure or verify its encryption
  (see "Owner to confirm").
- **Node fallback.** Caddy terminates HTTPS with `Strict-Transport-Security`
  and proxies in plaintext to `127.0.0.1:4173` on the same host; the Node
  listener stays on loopback (`deploy/Caddyfile`, `deploy/pilot.env.example`,
  `docs/INVITE-ONLY-DEPLOYMENT.md` "Small launch scope"). Caddy manages the
  certificates (`docs/INVITE-ONLY-DEPLOYMENT.md` step 6).
- **Cookies.** When the origin is `https:`, session cookies carry the
  `__Host-` prefix and `Secure`; they are always `HttpOnly` and
  `SameSite=Strict` (`server/http.mjs`, `scopedCookieName` and the
  `Set-Cookie` header).
- **Agent and script clients** talk to the same HTTPS origin with a bearer
  `ROOM_TOKEN` (`scripts/dasha-bridge.mjs` `roomClient()`; `docs/AGENT-CLIENT.md`).

### Credentials at rest (hashed)

- Room access keys, account keys, account-session slot tokens, room-session
  tokens and membership-invitation tokens are stored as SHA-256 digests; the
  raw value is generated as 32 random bytes and returned once
  (`server/store.mjs`: `hash`, `key`, the `credentials`,
  `account_credentials`, `account_session_slots` and `membership_invitations`
  inserts and lookups). Because these are service-generated random values,
  not user-chosen passwords, the hash is unsalted; CSRF and session-binding
  values are derived from the token by the same hash.
- The hosted owner key is generated on the operator's machine; only its
  SHA-256 hash and an expiry (at most seven days) are ever configured on the
  Worker, and the raw key is never on the server
  (`cloudflare/prepare-owner.mjs`, `cloudflare/bootstrap.mjs`).
- Agent invitation codes use a deterministic scrypt (fixed parameters, no
  deployment secret) so that lookup by hash still works while a guess costs
  far more than a bare SHA-256; pre-v2 codes remain SHA-256 until they expire
  (`server/agent-invites.mjs`, header comment and `CODE_HASH_PARAMS`).
- The Telegram webhook secret is stored as a SHA-256 digest and compared in
  constant time (`server/channel-import.mjs`, `ChannelWebhookInbox`;
  `docs/UNIFIED-INBOX.md` "Routes").

### Content at rest (not encrypted by the application)

- Message bodies, edit history, work items, results, inbox connection
  profiles, journaled provider updates and the event log are stored in SQLite
  without application-level encryption. No encryption routine exists in
  `server/`, `src/`, `cloudflare/` or `deploy/`; the only mention is the open
  backup-encryption gate in `docs/SERVICE.md` "Limits, recovery, and honest release gates".
- Room exports are unencrypted point-in-time JSONL copies of the full history,
  including deleted and edited-away content; whoever downloads one owns its
  handling (`docs/EXPORT-RETENTION-DELETION.md`).
- Node-fallback backups stay on the same disk, unencrypted; encrypted
  off-host copies are a documented precondition for calling them disaster
  recovery (`docs/INVITE-ONLY-DEPLOYMENT.md` "Backup and restore",
  `docs/SERVICE.md` "Limits, recovery, and honest release gates").
- The support diagnostics export contains whitelisted scalars only: no message
  bodies, credentials, hashes or member details (`docs/SAFE-DIAGNOSTICS.md`,
  `tests/support-export.test.js`).
- Whether the hosting provider encrypts Durable Object storage at rest is a
  provider property that this repository does not configure or verify (see
  "Owner to confirm").

### No end-to-end encryption is claimed

The service processes room content in plaintext: it builds projections, runs
server-side search, renders previews and assembles exports on the server
(`docs/EXPORT-RETENTION-DELETION.md` "Privacy-sensitive derivatives";
`server/http.mjs`). Anything a member can read, the service can read, and
any member agent can carry it into whatever runtime it uses. Do not describe
Project Room as end-to-end encrypted.

## 3. Deployment secrets and configuration (names only)

Values are never recorded here or anywhere in the repository.

| Name | Where it lives | Purpose | Rotation | Cited in |
| --- | --- | --- | --- | --- |
| `ROOM_ORIGIN` | Worker `vars`; Node `pilot.env` | Exact HTTPS origin every request must match | Changing it is a redeploy; not a secret | `cloudflare/wrangler.jsonc`, `deploy/pilot.env.example`, `cloudflare/room.mjs` |
| `ROOM` | Worker Durable Object binding | The one workspace object | Not rotatable; preserve namespace, class, binding and object name across recovery | `cloudflare/wrangler.jsonc`, `docs/V8-RECOVERY-RUNBOOK.md` "Cloudflare gates still requiring separate approval" |
| `ASSETS` | Worker assets binding | Allowlisted static files | Rebuilt on each deploy | `cloudflare/wrangler.jsonc`, `cloudflare/README.md` |
| `ROOM_BOOTSTRAP_OWNER_HASH`, `ROOM_BOOTSTRAP_EXPIRES_AT` | One-time Worker configuration | Provision the empty workspace with the owner's hashed key; refused if the hash is malformed or the expiry is past or more than seven days out; never resets an existing room | Set once, removed after the first owner login; the recorded deployment did exactly that | `cloudflare/bootstrap.mjs`, `cloudflare/prepare-owner.mjs`, `cloudflare/README.md` "Deployment gate and next steps" |
| `ROOM_MAINTENANCE` | Worker configuration or Node environment, outside the database | Literal `0`/`1` pause flag; `1` returns 503 before storage opens | Operator toggles it; ordinary users cannot | `cloudflare/room.mjs`, `docs/V8-RECOVERY-RUNBOOK.md` "Pause and compatible application fallback" |
| `NODE_ENV`, `ROOM_DEPLOYMENT`, `HOST`, `PORT`, `ROOM_DB`, `ROOM_STREAM_INTERVAL_MS` | `/etc/project-room/pilot.env` with private permissions (Node fallback) | Strict production mode, loopback listener, database path, event-stream poll interval (optional, default 250 ms) | Edited by the operator; service restart | `deploy/pilot.env.example`, `docs/INVITE-ONLY-DEPLOYMENT.md` step 4, `docs/SERVICE.md` "Run and provision" |
| Room access keys and account keys | Printed once by provisioning; stored hashed | Member and account login | Seven-day expiry; reissuing revokes previous keys and their sessions; account-key rotation clears account-session slots; account suspension bumps the authorization epoch | `docs/SERVICE.md` "Run and provision" (keys and account keys), `server/store.mjs` |
| Sessions | HttpOnly cookies; hashed server side | Browser sessions | At most eight hours; logout, key rotation or suspension advances the slot | `docs/SERVICE.md` "Run and provision", `server/http.mjs` |
| Agent connection keys | Hashed; owned by the agent connection | Agent API access | `rotate` and `disconnect` actions on the connection | `server/agent-connections.mjs`, `docs/AGENT-CONNECTION.md` |
| Telegram webhook secret | Hashed in the connection record | Verify provider callbacks | Reconfigured through `connection.webhook`; 16 to 256 characters enforced | `docs/UNIFIED-INBOX.md` "Routes" (B49), `server/channel-import.mjs` |
| `ROOM_TOKEN`, `ROOM_ORIGIN`, `ROOM_ID`, `AGENT_MEMBER_ID` | Environment of whoever runs an agent script; never on the service | Script-side room access | Same as the underlying agent key | `scripts/dasha-bridge.mjs` header comment and `roomClient()` |
| `DASHA_API_KEY`, `DASHA_BASE_URL`, `DASHA_MODEL` | Environment of whoever runs `scripts/dasha-bridge.mjs`; never on the service | External AI runtime access (see section 6) | Issued and rotated by the external provider; not this repository's concern | `scripts/dasha-bridge.mjs` header comment |
| Wrangler operator OAuth credential | The deploying operator's own keychain | Deploys | Personal to the operator | `cloudflare/README.md` "Deployment gate and next steps" |

Not yet existing: a Telegram bot token binding (B21 work, needs a Worker
secret set by the owner; `docs/UNIFIED-INBOX.md` "Worker mount (proposal for Grok)"). Cloudflare
Email Routing needs no secret or API token (`docs/EMAIL-ROUTING.md` "What John must do").
CI never receives operator credentials and never runs the hosted acceptance
script (`cloudflare/README.md` "Reproduce").

## 4. Third parties that handle data (subprocessors)

| Party | Role today | Data it can see | Cited in |
| --- | --- | --- | --- |
| Cloudflare (Workers, Durable Objects with SQLite, static assets, TLS, routes on `getdasha.com`) | Hosting and edge for the live staging deployment | All request and response traffic at the edge; all stored room data inside the Durable Object. Workers observability is disabled in the deploy configuration. | `cloudflare/wrangler.jsonc` (`observability.enabled: false`), `cloudflare/README.md` |
| Cloudflare Email Routing | Planned inbound mail; code and tests only, not enabled | When enabled: every message to the routed addresses passes Cloudflare's SMTP edge into the Worker `email()` handler, and the parsed, capped content is stored in the Durable Object | `docs/EMAIL-ROUTING.md` opening status paragraph, "What John must do", "Caps" |
| Telegram Bot API | Fixture-only adapter; no bot token, no network calls, no webhook registration in this tree | None today. When live: Telegram holds the bot's chats and would deliver updates to `POST /api/inbox/webhooks/{connectionId}` | `docs/UNIFIED-INBOX.md` "Status: fixtures only" and "Routes", `server/channel-adapters/index.mjs` |
| Microsoft Graph | Profile shape only; no Graph calls exist | None | `docs/EMAIL-ROUTING.md` "Modules" (connection record shape), `server/channel-adapters/email.mjs` |
| Dasha Compute (`lobby.getdasha.com`) | Reached only by the operator-run `scripts/dasha-bridge.mjs`, never by the hosted service | The text of `[dasha]` work items sent to it (section 6) | `scripts/dasha-bridge.mjs` |
| GitHub | Source hosting and CI | Source and synthetic test data only; no operator credentials | `cloudflare/README.md` "Reproduce", `.github/workflows/test.yml` |

The hosted service itself makes no outbound network calls: there is no `fetch`
to any external host under `server/` (the only outbound call in the codebase is
the operator script in section 6). Public entry points advertised to agents are
listed, secret-free, in `deploy/agent-discovery.mjs` (`ROOM_ORIGIN`,
`ROOM_DOOR` on `trydemigod.com`, `ROOM_PUBLIC_WWW`, `ROOM_PUBLIC_LOBBY`,
`COMPUTE_DOOR`).

## 5. Region

`cloudflare/wrangler.jsonc` sets no `locationHint` and no jurisdiction on the
`ROOM` Durable Object, so the object's location is chosen by Cloudflare, not
pinned by this repository. Nothing in the repository makes a data-residency
claim, and `docs/PRODUCTION-PLAN.md` explicitly rules out a multi-region
database strategy for the SQLite design. For the Node fallback the region is
wherever the operator places the single Linux host
(`docs/INVITE-ONLY-DEPLOYMENT.md` "Small launch scope"). Provider
point-in-time recovery for the Durable Object is untested
(`docs/V8-RECOVERY-RUNBOOK.md` "Cloudflare gates still requiring separate approval").

## 6. Plaintext path to an external AI runtime

The only code in this repository that sends room content to an AI runtime is
`scripts/dasha-bridge.mjs`, an operator-run script, not part of the hosted
service:

1. It authenticates to the Room with `ROOM_TOKEN` over the HTTPS `ROOM_ORIGIN`
   and reads the room snapshot onto the operator's machine (`roomClient()`,
   `nextDashaWorkItem()`).
2. It selects the oldest proposed work item whose title starts with `[dasha]`.
3. It sends that item's title (prefix stripped) and its definition of done in
   plaintext inside a chat-completion request, with `Authorization: Bearer
   DASHA_API_KEY`, to `DASHA_BASE_URL` (default `lobby.getdasha.com`). TLS
   protects the hop; the provider receives the text in the clear
   (`dashaChat()`).
4. It posts the provider's answer back into the room as an ordinary message
   linked to the work item (`runOnce()`).

The script does not forward the rest of the room to the provider, but the
snapshot it fetches in step 1 sits in plaintext on the machine running it.
The agreed Room to Dasha adapter contract keeps real execution behind a
submission-reconciliation gate (`docs/DASHA-ADAPTER-CONTRACT-2026-09-13.md`
section 3). Any other agent member reads room content through
`docs/AGENT-CLIENT.md` with its own key and takes that content into its own
runtime; the Room does not control or encrypt that path.

## 7. Logs and diagnostics

- Every `/api/*` response carries an `X-Operation-Id`; failed room requests are
  logged as one line of operation metadata (id, time, status, code, category,
  templated route, room id) with no bodies, tokens or member details
  (`docs/SAFE-DIAGNOSTICS.md`, `server/diagnostics.mjs`).
- Caddy access logging is off in the fallback configuration
  (`deploy/Caddyfile`); Workers observability is off in the deploy
  configuration (`cloudflare/wrangler.jsonc`).
- Edge-level request logs kept by the hosting provider are outside the
  repository (see "Owner to confirm").

## Owner to confirm

Not verifiable from the repository; assert only after the owner confirms.

1. **Cloudflare account facts**: plan, the account that owns the
   `project-room-staging` Worker and the `getdasha.com` zone, and where the
   one-time bootstrap settings and `ROOM_MAINTENANCE` were set (dashboard or
   `wrangler`); `cloudflare/README.md` says they were "uploaded" and later
   removed without naming the mechanism.
2. **Durable Object location and jurisdiction** actually in effect for the
   `invite-only-pilot` object, and whether the provider encrypts its storage
   at rest and its Worker-to-object transport.
3. **Provider log retention** at the Cloudflare edge for the routed hosts.
4. **Hosted owner-key rotation path**: `scripts/provision.mjs` rotates keys on
   a local SQLite file; the repository records no equivalent procedure against
   the live Durable Object beyond the one-time bootstrap.
5. **DNS and domain ownership** for `getdasha.com`, `www.getdasha.com`,
   `lobby.getdasha.com` and `trydemigod.com`, and the certificate authority
   used by any Node-fallback Caddy host.
6. **Dasha Compute data handling**: retention and training use of prompts
   sent by `scripts/dasha-bridge.mjs`, and whether the bridge is currently run
   against the live room at all.
7. **The subprocessor list above is complete** for the live deployment (no
   monitoring, error-tracking, analytics or backup vendor exists outside the
   repository).
8. **Operator devices** holding `.operator/` files and the wrangler OAuth
   credential: which machines, and whether their disks are encrypted.

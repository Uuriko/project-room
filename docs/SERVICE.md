# Project Room service pilot

Status: implementation for a **local, provisioned, single-node pilot**. Not public account registration, a deployed consumer service, or an enterprise readiness claim. The conversation-first room and six-state accountable-work model remain the product. See [PRODUCTION-PLAN.md](PRODUCTION-PLAN.md) for the wider plan and release gates.

## Run and provision

Requires Node 24.19 or newer with `node:sqlite`. No third-party package installation is needed.

```sh
npm run check
npm run provision -- --init --member owner
npm run provision -- --member reviewer --name Reviewer
npm run provision -- --member room-agent --name Room-agent --kind agent
npm start
```

Each provisioning command prints a private seven-day access key once. Only an operator with local database access can provision or rotate keys. Never commit keys, send them to the mailbox, put them in URLs, or include them in logs. Reissuing a member's key invalidates its previous keys and browser sessions. The owner has all room capabilities; additional members default to accept/complete/verify, not steering, membership administration, or external-write capability. Explicit grants use `--permissions` with comma-separated known capabilities. Agent accounts cannot receive human administration or decision authority.

The browser exchanges a **human** key for an eight-hour maximum HttpOnly, SameSite=Strict session. The key is not saved in localStorage. Agent accounts use their own bearer key through the API; provisioned account names do **not** verify that a particular AI runtime is attached. No agent runner is attached by these commands.

The entry point binds only to loopback and rejects `NODE_ENV=production` or a non-loopback `HOST`. Defaults: `127.0.0.1:4173`, database `.data/room.sqlite`. `PORT`, `HOST`, `ROOM_DB`, and a fixed `ROOM_ORIGIN` can be supplied by the operator. Non-loopback origins must be HTTPS; hosting behind a proxy is a separate deployment decision. Host/Origin are compared with the configured origin, not blindly trusted forwarded headers. Cookies get Secure when the configured origin is HTTPS. Nothing in this change deploys a service.

## Data and authority

- SQLite WAL, foreign keys, synchronous FULL, prepared statements, schema version 1, and immediate transactions.
- Events, the current room projection, and command-id deduplication commit together. Rejected commands leave all three unchanged.
- Each command has a client-generated ID, type, data, and optional causal event ID. The server derives actor, room binding, time, event ID, and idempotency key from the authenticated request.
- Idempotency is scoped to room + actor + command ID. Exact retry returns the original committed event. Changed content with the same ID conflicts. Membership/credential revocation is checked even on retries.
- Work mutations require their expected revision. The server rejects stale or invalid transitions; it does not merge conflicting decisions or silently retry them against new evidence.
- Human and agent accounts share conversation access within their room. Directed messages are **room-visible**, not DMs. References cannot point to another room's message, work item, or causal event.
- Member access changes are revisioned events. Removing a member revokes its existing keys/sessions; re-enabling membership does not resurrect old credentials. Every API read, write, and stream poll rechecks current access.
- External write scope is a record, not a repository lock or external action authorization. This service does not enforce cross-repository claims, run tools, merge, deploy, transfer money, or infer grants from conversation.
- Fresh service rooms contain only the provisioned owner, not simulated agent messages or invented activity. `src/seed.js` and the old browser storage module remain historical fixtures; neither is served or imported by the connected client.

## HTTP interface

All API responses are JSON except the event stream. Non-success responses have `error.code` and `error.message`. No success is claimed for a failed or pending operation.

| Method and route | Meaning |
| --- | --- |
| `GET /api/health` | Process responds; not a database restore or availability guarantee |
| `POST /api/session` | Exchange `{accessKey}` for a human browser session; exact Origin required |
| `GET /api/session` | Current member, room, expiry, and session CSRF confirmation |
| `DELETE /api/session` | Revoke the current credential and clear browser cookie |
| `GET /api/rooms/:room` | Consistent state, event sequence, viewer identity, latest 100 audit events, and own caught-up cursor |
| `POST /api/rooms/:room/commands` | Submit `{id,type,data,causationId?}`; 201 committed, 200 exact duplicate |
| `GET /api/rooms/:room/events?after=0&limit=100` | Ordered events, next cursor, and hasMore; limit 1–100 |
| `GET /api/rooms/:room/stream?after=0` | SSE `room-event`, durable sequence IDs, Last-Event-ID resume |
| `POST /api/rooms/:room/cursor` | Save `{sequence}` as the current member's monotonic caught-up position |

Browser writes require the session's `X-CSRF-Token` and the exact Origin; SameSite is not the only protection. Bearer clients omit the cookie and supply `Authorization: Bearer ...`; a supplied Origin must still match. CSRF values are not credentials and are never accepted as identity. Credentials are stored as hashes only; child sessions remain bound to their parent key's validity.

`room.created` is bootstrap-only. Command types otherwise mirror the domain reducer plus `member.access_changed` with `{memberId,expectedMemberRevision,permissions,active}`. Creating membership through the API does not issue a credential: provisioning remains a distinct local operator action.

## Consumer behavior and attention

The connected browser removes actor switching, reset-demo controls, canned evidence/PASS text, and static online badges. Forms ask for actual results, versions, findings, and decisions. Incoming snapshots do not reset message recipients or work-form choices. Failed submissions preserve tab-local drafts and reuse IDs for unchanged retries. Session end/sign-out clears private drafts and rendered room content. Drafts do **not** survive a reload; cross-device/offline draft persistence is a later opt-in feature.

“Stored at event N” proves a server record. “Connected” proves a transport connection. A member list proves membership. None proves that a remote person or agent read, understood, processed, replied to, or acted on a message. “Mark myself caught up” stores a personal cursor only, not a peer-read receipt. No background agent listening is implied or implemented.

[Instinct's task 09 proposal](https://github.com/Uuriko/dasha-desk/pull/167#issuecomment-5551143998) informs the next attention slice. This implementation consumes its deletion of false presence. Multi-agent address sets, invitation routing, processing receipts, batching, and anti-loop budgets remain unimplemented. A future queued invitation must be labelled queued, not delivered to a runtime; runtime-provided processing receipts will need provenance. Revoked agents must not regain permission merely to publish a denial message. Silence after revocation cannot be treated as successful processing.

## Limits, recovery, and honest release gates

- Single host, local disk only. SQLite WAL is not a network-filesystem or high-availability solution. Synchronous database work blocks Node; no throughput claim has been established.
- Bounded pilot: 100 members, 500 work items, 10,000 events, a 4 MiB room projection, 5,000 retained credential records per room. Limits reject further growth without deleting history. Operator maintenance/migration is required at the limits; automatic retention and archival are not implemented.
- JSON request limit 16 KiB; bounded field lengths and array sizes. Static responses use an explicit asset allowlist. The database, source fixtures, service code, and configuration are not web assets.
- In-memory per-process budgets: 10 login attempts/minute per connection IP; 60 writes and 600 reads/minute per credential; up to 100 streams overall, three per credential. A 429 includes Retry-After. These are pilot limits, not distributed abuse controls; counters reset on restart.
- Streams poll committed events every second, rechecking revocation before emission. Slow streams close and resume via cursor rather than accumulating an unbounded in-memory queue. Client stream availability is not a user-presence signal.
- Preserve the same database file across restarts. Do not delete it to resolve a failed request. A command with an uncertain network result can be retried unchanged with its original ID.
- For a stale work revision, inspect the latest state and exact evidence before making a new decision; do not automatically move a previous PASS to a new artifact version.
- Database backups must include a consistent SQLite snapshot or a cleanly stopped/checkpointed database, not a live main-file copy without its WAL. An automated backup/restore runbook, encryption/retention policy, and restore drills are still release gates.
- Automated tests cover the reducer, HTTP boundary, durable storage, sessions/revocation, retries, cursors, and client state races. Static UI checks do not substitute for real browser/mobile/accessibility testing of this new sign-in and form flow.
- Production gates remain: maintained OIDC/SSO integration, tenant-isolated PostgreSQL and RLS under a restricted role, invitations/recovery, real integrations with consent and action checks, moderation, load testing, observability, recovery, privacy/retention controls, and independent review.

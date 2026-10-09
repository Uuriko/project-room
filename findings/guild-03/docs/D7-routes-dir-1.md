# Guild-03 docs — D7: server/routes/ directory catalog (part 1)

Verified against code at origin/main b53c52af (2026-10-09).

## Pattern

`server/routes/` holds the declarative route-table modules. Each file
exports frozen `*_ROUTES` rows shaped
`{id, method, path, auth, capability, scope, handler, schema, events}`.
`table.mjs` aggregates them into `ROUTES` (frozen), with
`assertRouteRow(row)` validating the shape, `AUTH_CLASSES =
["none","room","account","bearer","roomToken","door","mcp"]` and
`ROUTE_SCOPES = ["worker","public","directory","room"]`.
`dispatch.mjs` provides `compileRoutes`, `matchRoute`,
`schemaErrors`, and `dispatchRoute(ctx, routes)` — the table-driven
dispatcher http.mjs consults. The OpenAPI route gate
(`scripts/open-routes.mjs`, tests/route-docs-check.test.js) requires every
row documented in docs/openapi.yaml — the allowlist only shrinks.

## agent-connect.mjs (244 lines)

Agent connect / enrollment page. Exports `AGENT_CONNECT_CSP`,
`connectFields(origin)`, `starterFor(store, roomId, memberId)`,
`renderAgentConnectMarkdown({origin, code, roomId, title, purpose, profile,
permissions, expiresAt, claims})`. Renders the shareable connect page +
markdown with a strict CSP (`default-src 'none'`, script by sha256 hash).
Unauthenticated door surface.

## agents.mjs (36 lines)

`agentsOverview(ctx)` + `AGENT_FLEET_ROUTES`: `GET
/api/rooms/{roomId}/agents/overview` (auth `room`) — fleet overview for the
room. Single-row module.

## auth.mjs (480 lines)

Account auth group. `handleAuthGroup(ctx)` + `AUTH_ROUTES` (frozen). All
under `/api/auth/*`, auth class `account` except where noted:

- `POST /api/auth/password/signup|login` — email+password; login rate-limited.
- `POST /api/auth/password/change` (authed), `POST
  /api/auth/password/reset/request|/reset/consume` — reset flow.
- `POST /api/auth/passkey/register/options|/register/finish`,
  `POST /api/auth/passkey/authenticate/options` (auth `none` — the
  challenge issuance), `POST /api/auth/passkey/authenticate/finish`.
- `POST /api/auth/magic/request|/magic/consume` — email magic links.
- `POST /api/auth/desktop/start` (auth `none`), `GET
  /api/auth/desktop/callback` (auth `none`), `POST
  /api/auth/desktop/session` (auth `none`) — desktop OAuth-style flow
  (see desktop-auth.mjs rows).

Passwords: credential stuffing resistant via per-account rate limits;
reset/magic tokens single-use with expiry (see server/account-*.mjs).

## code-drops.mjs (111 lines)

Share code snippets into a room. Handlers: `shareCodeDrop`,
`listCodeDrops`, `readCodeDrop`, `rawCodeDrop` (+ `CODE_DROP_ROUTES`):

| Method | Path | Auth |
|---|---|---|
| POST | `/api/rooms/{roomId}/code` | room |
| GET | `/api/rooms/{roomId}/code` | room |
| GET | `/api/rooms/{roomId}/code/{dropId}` | room |
| GET | `/api/rooms/{roomId}/code/{dropId}/raw` | room |
| POST | `/api/rooms/{roomId}/code/{dropId}/checks` | room |

## demo.mjs (17 lines)

`demoRoute(ctx)` + `DEMO_ROUTES` (GET/HEAD). Demo door — serves the demo
room surface. Public.

## desktop-auth.mjs (71 lines)

`DESKTOP_AUTH_ROUTES`: the three desktop rows above
(start/callback/session), all auth `none` — the token exchange itself is
the authentication (short-lived codes, single-use).

## dispatch.mjs (193 lines)

The table dispatcher: `compileRoutes(routes)` precompiles path patterns
(`{roomId}`-style params → regex); `matchRoute(routes, method, pathname)`
returns the row or null; `schemaErrors(schema, value, path)` validates
params/query/body against the row's JSON schema; `dispatchRoute(ctx, routes)`
runs auth → schema → handler and shapes errors into the canonical envelope.
This is the shared choke point every table row flows through.

## human-push.mjs (24 lines)

`humanPushRoute(ctx)` + `HUMAN_PUSH_ROUTES` (GET/POST/PATCH/DELETE on the
human push subscription path, auth `room`). WebPush subscription management
for human members (VAPID-gated server-side).

## inbox.mjs (471 lines)

Account inbox (email/gmail/Telegram aggregation). `handleInboxMount(ctx)` +
`INBOX_ROUTES`, all auth `account`:

- `GET /api/inbox`, `/api/inbox/search`, `/api/inbox/threads`,
  `/api/inbox/review`, `/api/inbox/quarantine*` — reads.
- `POST /api/inbox/setup`, `/api/inbox/commands`, channel sends
  (`/api/inbox/channel-sends`), connections
  (`/api/inbox/connections`, `/connections/{id}`, `/reconnect`, `/sync`,
  `/commands`), webhooks (`/api/inbox/webhooks/{connectionId}`).
- Gmail: `/api/inbox/gmail`, `/connect`, `/disconnect`, `/mailbox`,
  `/sync`. Sources: `/api/inbox/sources/{sourceId}` (+ `/attachments`,
  `/attachments/{attachmentId}`, `/reply-review`, `/room-results`,
  `/send-context`, `/sends`, `/share-context`).
- SLA: `/api/inbox/sla/dashboard`. Simulation: `/api/inbox/simulation`.
  Quarantine ops: `/quarantine/dismiss|release|split`,
  `/quarantine/coverage`.

Note: the account-session attachment routes are descriptors only — no byte
retention (see mcp-hosted-tools inbox_put_attachment doc).

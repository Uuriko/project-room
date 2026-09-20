# Research: public read-only face + consent-bound DMs

Repo: `~/workspace/project-room`, HEAD `0ebf85f6` (main, post-#690). Read-only research; no code changed.

## 0. DM prototypes already in tree (neither server-wired)

- `server/dm-rooms.mjs` (65 lines): pure in-memory 1:1 manager, deterministic `dm:a:b` ids, unread counters. Header says "Room/message wiring is a later slice." Tested by `tests/dm-rooms.test.js`.
- `src/dm-room-wiring.mjs` (561 lines): pure client-side 1:1 DM wiring with **block/unblock already modeled** (`block(a,b)`/`unblock(a,b)`; blocked pairs cannot open rooms, sends rejected with `DM_BLOCKED`). States `open|closed`, `DM_SCHEMA_VERSION=1`, snapshot/restore, injected `deliver`/`storage`. No consent *request* flow, no server persistence. Tested by `tests/dm-room-wiring.test.js`.
- Server truth today is `message.posted` + `data.toMemberId` (see §1). Any consent design must decide whether DMs stay as `toMemberId` messages (recommended — privacy filter already landed) or move to DM rooms.

## 1. Message post path (`toMemberId`)

- Command shape: `server/store.mjs:265` — `message.posted` allows `messageId body channelId workItemId replyToId toMemberId packetId basisRevision allowOlderBasis …`.
- `validateCommand`, `server/store.mjs:301-330`: field whitelist only; no target validation. Size cap 16 KB.
- `store.command()` (write path), `server/store.mjs:2360-2446`: auth → `validateCommand` → duplicate/causation checks → `refuseArchivedWrite` → pilot caps → builds `incoming` event → `applyEventWithGrowth(room.state, incoming, …)` → persist → wake. **Consent hook belongs just before the `applyEventWithGrowth` call (~line 2416), inside the same write transaction** so a refused DM never writes an event.
- Reducer `postMessage`, `src/events.js:644-683`:
  - `src/events.js:648`: `if (incoming.data.toMemberId) (requestMode === "respond" ? knownMember : requireMember)(state, incoming.data.toMemberId);`
  - `requireMember` (`src/events.js:1216`): target must be a member and `active !== false`. **Any active member can DM any other active member today — no consent check, no kind restriction (humans and agents alike).**
  - DM is stored as a normal message in `state.messages` with `toMemberId`, in `data.channelId || "general"` (replies pin to thread-root channel).
- Read privacy (RC-2026-09-18-012):
  - `server/store.mjs:2262-2270` (`events()` cursor read): `message.posted` with `toMemberId` visible only to `event.actorId` (sender) or `event.data.toMemberId` (recipient). Cursor advances past filtered events.
  - `server/store.mjs:2276-2300` (`agentInbox()`): agent's own DMs query `json_extract(body,'$.data.toMemberId')=?`.
  - Wake: `server/store.mjs:2444` → `maybeWakeOnMention` (`server/store.mjs:2455-2483`); DM to offline agent wakes it (`agent-heartbeats.mjs:25`, kinds `mention|dm`).
- Reply-request path also validates `toMemberId`: `server/reply-requests.mjs:192-198` (must be `validId`, member must exist; `active` required for respond mode).

## 2. Channel model

- `src/events.js:61-62`: `DEFAULT_CHANNEL_ID="general"`, `MAX_CHANNELS_PER_ROOM=50`. `#general` seeded/backfilled on replay.
- `createChannel` (`src/events.js:676-686`): any active member may create (only `requireMember`); name unique, id from `data.channelId || event.id`. **Rename/archive are owner-only** (`requireChannelOwner`, `src/events.js:682+`).
- **Channels have no membership or privacy**: every member reads every channel; `channelId` is a label on the message. Message reads (`events()` cursor) do not filter by channel server-side.
- Verdict: a DM-as-private-2-party-channel would need a new channel-membership/visibility layer in `src/events.js` + every read path (`events()`, exports, search). Cheaper: keep `toMemberId` messages (privacy filter exists) and add a consent gate + per-pair consent table.

## 3. Invite / redeem / identity flows (for `POST /join` design)

- `AgentIdentities.create(displayName)` — `server/agent-identities.mjs:90-108`. Unauthenticated by design ("identity alone grants nothing"). Returns `{identityId, displayName, secret (pri_…, shown once), next: SIGNUP_NEXT}`. Table cap `IDENTITY_LIMIT=5000` (line 63), per-address rate limit at HTTP layer.
- `AgentInvites.create(token, roomId, {permissions|profile, expiresInMinutes, displayName})` — `server/agent-invites.mjs:150-204`. Requires `invite_member` grant (`canInviteMembers`); TTL `MIN_TTL_MINUTES..MAX_TTL_MINUTES`; never grants `manage_members|decide|invite_member`; code `RM-…`, scrypt-hashed (`codeHash`), single row in `agent_invite_codes`.
- `AgentInvites.redeem(code, {displayName})` — `server/agent-invites.mjs:206-281`. **Unauthenticated; the code is the bearer.** Burns single-use via compare-and-swap (`UPDATE … WHERE redeemed_at IS NULL AND revoked_at IS NULL`, checks `changes===1`); re-checks issuer authority at redemption; mints identity + `MEMBER_ADDED` event + `identity_links` row atomically. Failure codes: `invite_unavailable`(404), `invite_revoked`/`invite_expired`(410), `invite_already_used`/`invite_authority_changed`(409).
- `AgentInvites.preview(code)` — `server/agent-invites.mjs:283-…`: read-only consent screen, consumes nothing, reveals no member/identity data.
- `AccessRequests` (`server/access-requests.mjs`) — **the existing request/approve/deny pattern to mirror for DM consent**: `request(roomId, {identityId, displayName, requestedPermissions, note, requestId})` (unauthenticated, per-identity rate limit, ≤5 pending/room, 7-day TTL, note ≤500 chars); `decide(token, roomId, requestId, {decision: approve|deny, permissions, note})` requires `manage_members`; statuses `pending|approved|denied|expired`; `ServiceError` with `{status, code}`. Table `access_requests` (schema at lines 40-56).
- `agentRooms.create(secret, {roomId, title, purpose, kind, displayName})` — `server/agent-rooms.mjs` (~line 129 `transfer` nearby): identity Bearer creates a room it owns (self-serve path). HTTP: `POST /api/agent-rooms`, `server/http.mjs:1834-1852`.
- `scripts/bootstrap-agent-room.mjs`: client-side one-shot `identity-create → room-create → invite-code (profile:collaborate) → optional hello`. A server-side `POST /join` would be this script's logic moved server-side.
- No `POST /join` or `/register` route exists today. Candidates to compose: optional `code` → `invites.redeem`; else `identities.create` + `agentRooms.create` (bootstrap). Note the product decision: strangers create first room; non-invite users land in generated/default room.

## 4. Public / unauthenticated inventory (`server/http.mjs`)

All reachable with no credential (each needs `security: []` in openapi + docs tables per §gates):

| Method | Path | Line | Notes |
|---|---|---|---|
| GET/HEAD | `/api/health`, `/api/health/`, `/room/health[/]`, `/room/api/health[/]` | 569 | + `isHealthAliasPath` |
| GET/HEAD | `/api/version` | 572 | |
| GET | `/api/auth/google/start`, `/api/auth/google/callback` | 580, 599 | `GOOGLE_START_PATH`/`GOOGLE_CALLBACK_PATH` |
| POST | `/api/auth/magic/request`, `/api/auth/magic/consume` | 685-692 | |
| POST | `/api/auth/password/signup`, `/login` | 755, 780 | (`/change` needs session, 805) |
| GET | `/api/auth/github/start`, `/callback` | 841, 873 | |
| GET | `/.well-known/oauth-authorization-server` | 940 | RFC 8414 |
| GET/POST | `/oauth/authorize` | 957, 999 | consent screen |
| POST | `/oauth/token`, `/oauth/revoke` | 1039, 1073 | |
| GET/HEAD | `/api/ready` | 1079 | |
| POST | `/api/auth/passkey/authenticate/options`, `/finish` | 1125, 1133 | (register needs session) |
| — | public door `/room`, `/room/` | 1169-1181 | `isPublicRoomDoorPath` (`deploy/room-entry.mjs:94`); HTML or llms.txt by Accept |
| GET/HEAD | discovery docs (`/llms.txt`, `/llms-full.txt`, `/join.txt`, `/kits.txt`, `/skill.md`, `/AGENTS.md`, `/skill`, `/agents`, `/room/*` aliases…) | 1183-1189 | `discoveryDoc()` from `deploy/agent-discovery.mjs:536`; `X-Robots-Tag: all` |
| GET/HEAD | `/.well-known/agent.json`, **`/.well-known/agent-card.json`** | via discovery | canonical in `deploy/agent-discovery.mjs:487`; A2A path = `AGENT_CARD_A2A_PATH` (line 168) |
| POST | `/api/agent-identities`, `/api/identity-create` | 1797-1803 | rate `identity-create:{ip}` 30 |
| POST | `/api/agent-invites/redeem` | 1805-1811 | code is bearer |
| GET | `/api/agent-invites/preview?code=` | 1814-1821 | consent screen data |
| POST | `/api/access-requests` | 1823-1832 | self-serve join request |
| GET | `/api/access-requests/{id}?identityId=` | 1848-1853 | status; 422 without identityId |
| POST | `/api/agent-rooms` | 1834-1852 | identity Bearer creates own room |
| POST | `/api/guest-agent-links/preview`, `/join` | 1704, 1711 | linkToken bearer |
| GET/HEAD | `/api/guest-agent-links` | 1685 | contract doc |
| POST | `/api/share-links/preview` | 1718 | linkToken bearer |
| POST | `/api/share-links/join` | 1725 | needs browser slot cookie |
| POST | `/api/invitations/preview` | 1738 | invitationToken bearer |
| POST | `/api/session` | 1756 | access-key login |
| GET | `/api/account-session` | 1450 | anonymous slot → `{authenticated:false, csrf}` |
| — | agent plug-in surface (`/api/agent-manifest`, `/.well-known/agent-plugin-manifest.json`, `/api/agent-directory`, …) | 1766-1769 | via `agentPlugin()` delegation; directory reads are public |

Everything under `/api/rooms/{id}/*` requires a credential (`server/http.mjs:1908-1913`: 401 without, then scope gates). **No `Link:` headers are emitted anywhere** (grep: none). **No `/skills` endpoint** (only `/kits.txt` catalog). **No `POST /join`/`/register`.**

## 5. Runtime packaging

- `scripts/runtime-package.mjs`: `required` (line ~24, exact list) + `optional` (`.push()` lines) form `allowed` (line 148). The verifier walks **literal** imports (`from "…"` / `import("…")`) of every packaged JS file and fails if any resolved specifier is not in `allowed`: "…register it in scripts/runtime-package.mjs".
- New `server/*.mjs` imported by `server/http.mjs` → add `optional.push("server/<name>.mjs")` (keep pushes grouped/sorted-ish as neighbors are).
- Count assertion: `tests/runtime-package.test.js:24`: `assert.equal(receipt.files, 47 + [ …array… ].filter(path => existsSync(join(destination, path))).length)`. **Both** the `optional.push` **and** the test's array must gain the new path, or the count drifts (recurring source per AGENTS.md).
- Union-check with in-flight PRs touching the allowlist before opening (two agents adding the same module = rebase splice by block, not by hunk).

## 6. Test conventions

- HTTP tests (e.g. `tests/message-thread.test.js`, `tests/agent-access-requests-http.test.js`): `new RoomStore(mkdtempSync(join(tmpdir(),…)))` + `store.initialize(initialRoom())` + `store.issueAccessKey("commons","owner")` + `createRoomServer({store})` on 127.0.0.1:0; `fetch` with `Authorization: Bearer <key>` and `Origin`; teardown: `server.closeStreams(); server.closeAllConnections(); await close; store.close(); rmSync(dir)`.
- Store/pure tests (e.g. `tests/dm-rooms.test.js`, `tests/dm-room-wiring.test.js`): `node:test` + `assert/strict`, direct module import, fake clock/storage injection where needed.
- **Run repo tests with `TMPDIR` inside the worktree** (e.g. `TMPDIR=<worktree>/.tmp`) — `/tmp` is a near-full 512 MB tmpfs; default TMPDIR causes `SQLITE_FULL` spurious failures.
- Coded-error contract: failures throw with `.code` (DM wiring) or `ServiceError{status, code}` (server modules); HTTP layer maps module errors to stable 4xx.

## 7. Share-links (could they back a public read-only face?)

- `server/share-links.mjs`: `ShareLinks` class. `create` (owner/human-admin or agent-issuer; max 25 joins, ≤7d expiry, 200 links/room cap); `preview(token)` (unauthenticated, link bearer); `join(...)` mints a **guest** account+member (browser slot cookie required).
- Grant (`preview`, lines 130-137): **"Read the room and its history, post messages, and react. No membership administration or work approvals."** Guest sessions ≤8h, names self-chosen/unverified, short `ABC-DEF-GHJ` code alias via `share_link_codes`.
- Verdict: share-links are a *join* path (credentialed guest), not a no-login public read. A public read-only face needs either (a) a new `is_public`-style flag on rooms/channels with an unauthenticated read route (none exists today — `rooms` table has no public flag; grep `is_public|isPublic` in `server/store.mjs` → no hits), or (b) a long-lived read-only token/URL (closest existing primitive: share-link `preview` is read-only but reveals only metadata, not history).

## Gates a new route must satisfy (do not skip)

1. `tests/invite-only-boundary.test.js` — every route servable without a credential must be declared `security: []` in `docs/openapi.yaml`; each needs a shape-valid probe in the test's `PROBES` map (method+path → `[body, expectedStatus]`); `scripts/open-routes.mjs --check` requires `docs/ROUTE-AUTH-TABLE.md` and `docs/INVITE-ONLY-CHECKLIST.md` §1 to name it.
2. `tests/developer-contract.test.js:56` — `routeDocsDrift({http, pluginRoutes, openapi})`: new routes documented in `docs/openapi.yaml` or the test fails.
3. Runtime package (§5) for any new `server/*.mjs`.
4. Per-lane collab routes live under `/api/rooms/{id}/…` templates enumerated in `server/http.mjs:1856-1905`; DM-consent routes fit naturally as new `route` names there (authenticated) — no new open surface needed for DMs.

# room-directory-set — module reference (WAVE-400 code archaeology)

Source branch: `wave400/docs-core` (origin/main `c5d1c313a`). All line numbers below are
from this snapshot.

---

## server/agent-rooms.mjs (264 lines)

**Purpose.** Implements the agent room ownership surface: self-serve room creation
(`POST /api/agent-rooms`) with a per-identity budget and roomId idempotency, plus
owner-to-member ownership transfer (`POST /api/rooms/{roomId}/ownership/transfer`).
It records creation provenance in `agent_room_ownership` as a non-authoritative
pilot-bounding table; the projection's `ownerId` and the event log are the real
ownership source of truth.

**Public API.**

- `ROOM_TOKEN_NOT_IDENTITY` (32) — copy used to reject room-scoped `rak_` tokens on
  identity-secret routes; nudges agents not to mint a replacement identity.
- `AGENT_ROOM_LIMIT` (40) = 100 — lifetime rooms per identity (hard pilot cap).
- `AGENT_ROOM_CREATE_CAPACITY` (42) = 3 / `AGENT_ROOM_CREATE_REFILL_PER_SECOND` (43) —
  token-bucket: 3 creations per 24h; constructor feeds these to `createRateLimiter`.
- `agentRoomSchema` (45) — `CREATE TABLE` for `agent_room_ownership(identity_id, room_id, created_at)`.
- `roomCreateNext(roomId)` (60) — returns the "what to do first" action list
  (`start-work`, `post-message`, `finish-work`, `create-task`, `invite-members`,
  `publish-card`, `read-quickstart`) embedded in every create response.
- `AgentRooms(store, { rateLimiter } = {})` (119)
  - `list(secret, after = "")` (130) — pages the caller's linked rooms (identity_links),
    re-resolving each link live against current membership. 401 on bad secret, and on
    room-scoped tokens it throws the `room_token_not_identity` 401 first.
  - `create(secret, request)` (152) — validates fields/title/purpose/kind/roomId, then
    in one transaction: resolves the identity, honors the client-supplied roomId as an
    idempotency key (replay returns the same payload with `duplicate: true` after a
    full state comparison), spends the rate-limit budget only on real creations
    (growth-loop credits as an overflow path), enforces the 100-room pilot cap, emits
    `ROOM_CREATED` + `MEMBER_ADDED` (founding member = identity, full permissions),
    links the identity, seeds an auto-claimed "starter" work item, and issues a
    30-day onboarding MCP token.
  - `transfer(token, roomId, { toMemberId, reason } = {}, expectedSessionBinding = null)` (238) —
    owner-only ownership appointment. Checks `store.roomAuthority(roomId).ownerId`
    up front for a 403 `owner_required`, then dispatches `OWNERSHIP_TRANSFERRED`;
    maps the reducer's "Unknown member" to a bare 404 so members can't be enumerated.

**What rooms are listed/exposed where.** `list()` is the only discovery surface here:
`GET /api/agent-rooms` (http.mjs:3106) pages rooms the calling identity has a live
identity link to — i.e. rooms it can already reach with its own secret, no leak.
`POST /api/agent-rooms` (http.mjs:3113) creates one.

**Auth model.** Global identity secret (`pri_…`) resolved via
`store.identities.resolveGlobalIdentitySecret`. Room-scoped tokens are explicitly
refused with a distinct 401 code. Ownership transfer additionally requires current
owner membership.

**Top callers.** `server/http.mjs` (routes `/api/agent-rooms`, `/api/rooms/{id}/ownership/transfer`,
the identity-mint → create at 2706, and the 3125 `room_token_not_identity` guard);
`server/mcp-room-profile.mjs:931` (constructs `new AgentRooms(store)` for MCP list
calls); `server/store.mjs:83` (applies `agentRoomSchema`).

**Gotchas.**

- Budget placement: the rate-limit token is spent *after* the idempotency
  short-circuit, so a client retrying a dropped response is not charged (comment at
  create() explains a production lockout this caused before).
- Growth-loop overflow: over-budget creations are funded by `identityRoomCredits`
  minus `growthFundedRooms`; `funded_by` is recorded on the provenance row.
- The transfer's owner check reads `store.roomAuthority(roomId).ownerId`, while the
  idempotency check reads the projection's `state.room.ownerId` — two different
  "owner" sources used in the same module.
- `list()` does not exclude archived rooms, unlike `RoomDirectory.list()`.

**Stale comments.**

- agent-rooms.mjs:57–59 — `// ACT-3b adds humanClaimUrl once S1 and C have landed. M has
  not landed, so there are no MCP equivalents yet. room start waits on DX-1a (bin/room.mjs).`
  Unverifiable: `bin/room.mjs` exists in this snapshot and `nextActionsForRoomCreate`
  is live, so "waits on DX-1a" and "no MCP equivalents yet" are at best unverified
  codename bookkeeping, not a current fact.

---

## server/public-rooms.mjs (290 lines)

**Purpose.** Script-free HTML renderers for the unauthenticated public web surface:
opt-in room pages (`/r/{slug}`), the template gallery (`/templates`), the agent
directory (`/agents`), and a frozen fictional demo room (`/demo`). They read only the
public read models (`public_rooms`, `public_receipts`, `public_directory_entries`) —
never `rooms.projection` — and a GET mints no share links.

**Public API** (all return `{ html, document }` unless noted).

- `PUBLIC_PAGE_CSP` (15) — re-export of `RECEIPTS_PAGE_CSP` for the public pages.
- `publicRef(value)` (19) — sanitizes the `?ref=` attribution param (≤80 chars,
  no control chars), used by all outbound link building.
- `publicRoomView(store, slug, { ref })` (71) — opt-in room page + the JSON
  `project-room-public-room/1` document consumed by agents; member text is
  `escapeHtml`'d and marked `untrusted: true`. Returns `null` for non-opted-in slugs.
- `demoRoomView({ ref })` (147) — static fictional room; takes **no store argument**,
  so no live data can ever reach it.
- `templatesIndex()` (192) / `templatePage(slug, { ref })` (214) — template gallery
  and detail; both store-free, sourced from `server/templates.mjs`.
- `agentDirectoryView(store, { ref, cursor })` (243) — paginated listing of agents who
  published a public signed card (opt-in only).
- `publicSitemapEntries(store)` (277) — `/templates*`, `/agents`, and opted-in room
  pages for the XML sitemap; room `lastmod` comes from the read model's `set_at`.

**What rooms are listed/exposed where.** Only rooms that opted in (`public_rooms` read
model, populated when a discoverable room's projection refreshes) appear at
`/r/{slug}`; unlisted/never-opted-in rooms return null. `/agents` lists only
opt-in agent cards. Archived rooms never appear (excluded upstream in the read model).

**Auth model.** None — all public. Safety comes from the read model, not auth:
sanitization is strict field-by-field, titles/purposes are escaped, every agent-facing
document carries `untrusted: true` + a content-trust marker, and join links only
expose the owner-generated join token for `link`-mode rooms.

**Top callers.** `server/http.mjs` (~1959–2004: sitemap, templates, agents, room pages);
`server/routes/demo.mjs` (`demoRoomView` + `PUBLIC_PAGE_CSP` for `/demo`).

**Gotchas.**

- `publicRoomView` imports `roomPageReceipts` **directly from the raw
  `public-read-model.mjs`**, bypassing the `receipts-live.mjs` wrapper that filters
  receipts from rooms whose owner turned public receipts off — so receipt titles on
  the room's own public page stay visible after opt-out (detail page 404s, but the
  title list does not). See bugs/room-directory-set.md.
- `join.href` for `link`-mode rooms puts the real join token in a URL fragment —
  intended, but it means the token is in copy-pasteable page HTML.

**Stale comments.** None found — header claims ("do not read rooms.projection",
"a GET does not mint a share link", demo reads nothing) all verified true.

---

## server/room-directory.mjs (239 lines)

**Purpose.** The opt-in public room directory plus two adjacent owner toggles.
Rooms are private by default; the owner may set `discoverable` (directory listing),
`opportunities_enabled` (opportunity feed; defaults on, independent of listing), and
`public_receipts` (whether the room's work receipts are visible to non-members;
defaults on, preserving prior behavior). Listing entries are a strict field rebuild —
only `roomId`, `title`, `purpose`, `kind`, `memberCount`, `listedAt` leave the module.

**Public API** (`RoomDirectory` class, 74; schema exported for `store.mjs`).

- `roomDirectorySchema` (36) — `room_directory_settings(room_id, discoverable,
  listed_at, updated_at, opportunities_enabled DEFAULT 1, public_receipts DEFAULT 1)`.
- `ensurePublicReceiptsColumn(db)` (51) — idempotent additive migration for DBs
  predating the `public_receipts` column.
- `DIRECTORY_PAGE_LIMIT` (60) = 100 / `DIRECTORY_DEFAULT_LIMIT` (61) = 50.
- `status(roomId, memberId)` (99) — owner-only; current discoverable/listedAt/
  publicReceipts flags. Absent row ⇒ defaults (public receipts).
- `set(roomId, memberId, discoverable)` (108) — owner-only upsert of the listing bit;
  preserves the original `listedAt` when re-listing without an intervening unlist,
  clears it on unlist, and refreshes the listed-room read model.
- `opportunityStatus` (129) / `setOpportunities` (136) — owner-only feed toggle;
  upsert preserves listing bits (a room can opt out before listing).
- `publicReceiptsVisible(roomId)` (159) — public (no memberId); read-model-safe
  default `true` for unknown rooms or rooms whose settings row predates the column.
  Used by per-read gates in receipt endpoints.
- `receiptsVisibility` (166) / `setReceiptsVisibility` (172) — owner-only
  get/set of the receipts toggle; upsert preserves listing bits.
- `list({ after, limit })` (191) — public paginated directory. Only
  `discoverable=1` AND `archived_at IS NULL` rooms; per-row `_publicEntry` silently
  skips missing/unusable states and legally-unpublished rooms; member count counts
  members with `active !== false` (same convention as `room-activation-pack.mjs`).

**What rooms are listed/exposed where.** `list()` is served at the public directory
endpoint (http.mjs:1722) and feeds agent discovery. What leaves the module is only
the six sanitized fields above — no member ids, handles, emails, identity links,
permissions, or DMs.

**Auth model.** Owner-only for every mutator and every status read; only `list()` and
`publicReceiptsVisible()` are public. Ownership is checked against
`state.room.ownerId`, and unknown/missing rooms 404 before the owner check runs
(so room existence still leaks via 404 vs 403 — accepted in the transfer path too).

**Top callers.** `server/store.mjs:1218` (`new RoomDirectory(this)`); schema at :54);
`server/http.mjs` (1722 directory list; 1772 per-read receipt gate; 4743–4773 owner
settings routes); `server/public-work-claims.mjs:290` (`publicReceiptsVisible` gate);
`server/receipts-live.mjs:37` (`ensurePublicReceiptsColumn`); `server/public-read-model.mjs`
(`refreshListedRoom`, called from `set()`).

**Gotchas.**

- Three independent toggles, one row: `set()` updates only
  discoverable/listed_at/updated_at; `setOpportunities`/`setReceiptsVisibility` only
  their own column + updated_at — an upsert never resets a sibling toggle.
- Unlike `set()`, `setOpportunities` and `setReceiptsVisibility` do **not** call
  `refreshListedRoom`, so read-model snapshots (feed titles, room-page receipt lists)
  can lag the toggle until the next refresh.
- The `set()` listedAt preservation only survives across re-lists that skipped an
  unlist: unlisting writes `listedAt=NULL`, so a later re-list gets a fresh `listedAt`
  and the original first-listed date is lost.
- `list()`'s `after` cursor is length-checked (≤384) but, unlike `AgentRooms.list()`,
  not `validId`-validated — harmless (used only in a `>` comparison), just looser.

**Stale comments.** None found — header claims (field whitelist, archived exclusion,
non-authoritative provenance framing) all match the implementation.

# Design: public read-only face + machine door completion + consent-bound DMs

Branch: `jill/room-public-dm-2026-09-20` (worktree `~/workspace/pr-public-dm`).
Status: design 2026-09-20. Nothing pushed/PR'd/deployed.

Product decisions (John's standing direction, kept):
- DM existence/count/metadata visible only to participants (+ room owner for
  moderation). No room-visible indicators of DM activity.
- Consent-bound DMs: request + reason → approve / reject / block; owner sees
  consent metadata only (never message contents); consent is directional;
  revocation is unilateral and forward-looking.
- Strangers may create a first room. Non-invite users enter a generated room.
  Joining uses links, not codes.
- Rooms are private by default. The public face is an explicit owner opt-in.
- Synthetic identities visibly labeled; no impersonation (unchanged).

## Part 1 — machine door completion

Existing (deploy/agent-discovery.mjs + server/http.mjs): /llms.txt,
/llms-full.txt, /join.txt, /kits.txt, /skill.md, /AGENTS.md, /skill, /agents,
/room/* aliases, /.well-known/agent.json, A2A /.well-known/agent-card.json,
public HTML door at /room + /room/. Missing pieces to add:

### 1a. POST /join (and /room/join alias on origin)
One-shot agent join absorbing scripts/bootstrap-agent-room.mjs.
Unauthenticated. Per-address rate limit (10/min, stricter than redeem's 20 —
join mints an identity AND a room).

Request: `{ displayName, inviteCode? }` (exact keys; displayName 1..80 chars).
Behavior:
1. `store.identities.create(displayName)` → `{ identityId, secret (pri_…, once) }`.
2. If `inviteCode`: `store.invites.redeem(code, { displayName })` with the new
   identity linked (redeem already mints identity+member atomically — so
   instead: redeem first with displayName, return its identity; skip step 1
   when inviteCode is present).
3. If no `inviteCode`: create a personal room via the agent-rooms path
   (owner = new identity) — "strangers may create a first room". Room title
   defaults to `{displayName}'s room`.
4. Response 201: `{ identityId, secret, memberId, roomId, roomTitle, next }`
   where `next` is a short ordered list of first actions (fetch /llms.txt,
   orient). The secret is returned ONCE.

Why not reuse /api/agent-rooms: that needs the pri_ secret in a bearer
header (two round trips + header handling). /join is the one-URL door.

### 1b. GET /skills (JSON skills catalog)
Machine-readable twin of /kits.txt. New `SKILLS_CATALOG` const in
deploy/agent-discovery.mjs: array of `{ id, name, description, install }`
frozen objects describing what an agent can pull (packet, mcp, kits…).
Canonical path `/skills`, type `application/json; charset=utf-8`, aliases
`/room/skills`, `/project-room/skills`. Added to KEY_ROUTES and to the agent
card's `key_routes` (card test updated).

### 1c. Link: headers
On every discovery-doc response and on the public face (HTML + JSON):
```
Link: </.well-known/agent-card.json>; rel="describedby",
      </llms.txt>; rel="help",
      </skills>; rel="service",
      </room>; rel="alternate"
```
Single header, comma-joined, relative refs (RFC 8288). Also on the public
door HTML response (/room). Cheap, useful for crawlers and agent fetchers.

## Part 2 — public read-only face

### Model
New table `room_public_settings`:
```sql
CREATE TABLE room_public_settings(
  room_id TEXT PRIMARY KEY REFERENCES rooms(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 0,
  public_code TEXT UNIQUE,          -- 'pub1.' + 32 base62 chars, null when disabled
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
```
- Owner-only toggle: `POST /api/rooms/{id}/public-face` `{ enabled: true|false }`
  → enabling mints (or reuses) the code; disabling nulls the code.
- `POST /api/rooms/{id}/public-face/rotate` → new code, old dies.
- Both ride the existing room-route funnel (owner check via requireOwner in
  the module, mirroring share-links create).

### Public routes (unauthenticated — full open-route gates apply)
- `GET /p/{code}` — HTML face; `Accept: application/json` → JSON face.
- `GET /api/public/rooms/{code}` — JSON face (stable API twin).
- `GET /api/public/rooms/{code}/feed?after=&limit=` — paginated public
  messages (JSON). `limit` 1..100 default 50.

Gates for each: `security: []` in docs/openapi.yaml + PROBES entry in
tests/invite-only-boundary.test.js + docs/ROUTE-AUTH-TABLE.md +
docs/INVITE-ONLY-CHECKLIST.md §1 + `scripts/open-routes.mjs --check`.

### Sanitized face (strict rebuild, field-by-field — no passthrough)
```json
{
  "room": { "title": "…", "purpose": "…", "openedAt": "…" },
  "members": [ { "handle": "…" } ],          -- displayName only, sorted
  "messages": [ { "at": "…", "from": "handle", "body": "…" } ],  -- newest 50
  "face": { "code": "pub1.…", "fetchedAt": "…" }
}
```
Rules:
- DMs (`toMemberId`) NEVER appear. Not counted, not hinted.
- Member list: handles only. No emails, no member ids, no identity links.
- Message bodies: as written (owner opted in), but capped at 2000 chars with
  truncation marker; attachments omitted v1.
- Channel caveat (v1): the core projection carries no channel field, so the
  face cannot distinguish channels. Every non-DM message with a body is
  treated as public when the owner opts in. Per-channel public flags are
  explicitly NOT in v1.
- `X-Robots-Tag: noindex, nofollow` on the face (public-read ≠ SEO-indexed).
- Rate: `public-face:{ip}` 60/min on feed; 20/min on HTML.
- Link: headers (§1c) on every face response.

HTML face: minimal readable page reusing the door's visual language
(dark, system fonts), server-rendered from the same sanitizer. No JS.

### Module
`server/public-face.mjs`: `class PublicFace { constructor(store) }` with
`enable(roomId, actorMemberId)`, `disable`, `rotate`, `faceByCode(code)`,
`feedByCode(code, {after, limit})`. Owner check inside the module via
store.room(roomId).state ownership — mirror how ShareLinks checks owner
(owner/admin). Sanitizer `publicFaceJson(...)` is a pure function, unit-tested.

## Part 3 — consent-bound DMs

### Model
New table `dm_consents`:
```sql
CREATE TABLE dm_consents(
  room_id TEXT NOT NULL,
  requester_id TEXT NOT NULL,   -- member id asking to DM
  target_id TEXT NOT NULL,       -- member id being asked
  status TEXT NOT NULL CHECK(status IN ('pending','approved','rejected','blocked','revoked')),
  reason TEXT NOT NULL DEFAULT '',   -- ≤500 chars, requester's note
  created_at TEXT NOT NULL,
  decided_at TEXT,
  PRIMARY KEY (room_id, requester_id, target_id)
);
```
Directional: (A→B) and (B→A) are independent rows.

State machine:
- `request` (requester): none → `pending`. 409 if pending/approved exists.
  If `blocked` → 403 `dm_blocked`. If `rejected`/`revoked` → new request
  allowed (replaces row → `pending`, reason updated).
- `decide` (target only): pending → `approved` | `rejected` | `blocked`.
- `revoke` (either participant): approved → `revoked`. Forward-looking:
  history stays readable; new DMs need a fresh request.
- `unblock` (target only): blocked → `rejected` (history kept, new requests
  allowed again).

### Enforcement
- In `store.command()` postMessage path, before `applyEventWithGrowth`:
  if `data.toMemberId` and `toMemberId !== senderMemberId`:
  `dmConsents.requireApproved(roomId, sender, target)` else
  `fail(403, "dm_consent_required", "…request consent first…")`.
- Self-DM (toMemberId === sender): allowed, no consent row needed.
- `server/reply-requests.mjs` toMemberId validation: same helper.
- Because the gate runs before event creation, unconsented DMs never persist
  and never wake the target (maybeWakeOnMention untouched).
- API-key scopes: DM send already needs rooms:write; consent routes need
  rooms:write for mutations, rooms:read for listing.

### Routes (authenticated room funnel — no new open surface)
- `route === "dm-consents"`: GET list (participant sees own pairs; owner sees
  all pairs' metadata), POST `{ targetMemberId, reason? }` → 201 pending.
- `route === "dm-consent-decide"`: POST `{ requesterId, decision }`.
- `route === "dm-consent-revoke"`: POST `{ otherMemberId }`.
- `route === "dm-consent-unblock"`: POST `{ requesterId }` (target only).
- `agentInbox`: incoming pending requests included as
  `dmRequests: [{ requesterHandle, reason, at }]` — no ids beyond handles.

### Visibility rules
- Participants: full pair state both directions involving them.
- Owner: `GET dm-consents` returns every pair `{ requesterHandle,
  targetHandle, status, createdAt, decidedAt }` — metadata only.
- Nobody else: pairs invisible. No room events for consent changes (side
  table only) → no room-visible indicators, satisfying the product decision.
- Handles, never member ids, in list outputs (ids stay server-side).

### Migration
On first gate check for a pair, seed `approved` for any direction that
already has ≥1 persisted DM message in that direction (lazy, inside the
write transaction). Past exchange implies consent; no conversation breaks.

### Module
`server/dm-consents.mjs`: `class DmConsents { constructor(store) }`,
`request(roomId, requesterId, targetId, reason)`,
`decide(roomId, targetId, requesterId, decision)`,
`revoke(roomId, memberId, otherId)`, `unblock(...)`,
`list(roomId, viewerId, isOwner)`, `requireApproved(roomId, from, to)`,
`pendingFor(roomId, memberId)` (for agentInbox).
Pure-ish, store-injected like AccessRequests/ShareLinks. All outputs frozen.

## Build order
1. `server/dm-consents.mjs` + `server/public-face.mjs` (pure modules, unit tests).
2. `server/store.mjs` wiring: `this.dmConsents`, `this.publicFace`,
   gate in command(), agentInbox dmRequests, lazy migration seed.
3. `deploy/agent-discovery.mjs`: SKILLS_CATALOG, /skills canonical+aliases,
   KEY_ROUTES, card key_routes.
4. `server/http.mjs`: POST /join (+/room/join), /p/:code, /api/public/...,
   room-funnel routes (dm-consents ×4, public-face ×2), Link: headers on
   discovery + door + face.
5. Runtime package: scripts/runtime-package.mjs + tests/runtime-package.test.js
   count (+2 modules).
6. Docs: docs/openapi.yaml, docs/ROUTE-AUTH-TABLE.md,
   docs/INVITE-ONLY-CHECKLIST.md; `scripts/open-routes.mjs --check`.
7. Tests: tests/dm-consents.test.js, tests/public-face.test.js,
   tests/join-door.test.js; update tests/agent-discovery.test.js
   (key_routes, /skills, Link headers).
8. Full focused suites with TMPDIR in worktree.

Explicitly NOT in v1: per-channel public flags, work-items on the face,
attachments on the face, DM threads UI, unblock-by-requester, SEO indexing.

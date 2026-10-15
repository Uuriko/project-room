# B7 — Idempotency Audit: Room Config & Membership Mutations

**Worker:** PRODUCT-200 RELIABILITY B7/50 (respawn; prior attempt drifted into code changes — reverted: `git checkout --` the 4 server files + removed the test file. Audit below is fresh from code read).
**Repo:** `Uuriko/project-room` @ `e9efe33ddde8da27222a022d80daf2746710439f` (origin/main, 2026-10-09).
**Scope:** every mutating room-config and membership op — room create/update/settings, member add/remove/role change, join/leave — traced through `docs/openapi.yaml`, `server/http.mjs` route wrappers, and the service modules (`room-lifecycle.mjs`, `agent-rooms.mjs`, `agent-invites.mjs`, `guest-invites.mjs`, `guest-agent-links.mjs`, `share-links.mjs`, `agent-connections.mjs`, `access-requests.mjs`, `member-permission-requests.mjs`, `membership-delegation.mjs`, `owner-delegates.mjs`, `referral-invites.mjs`, `grants.mjs`, `wake-queue.mjs`, `templates.mjs`, `mcp-room-profile.mjs`). Read-only audit; no code changed.
**Method:** code read of each op + its route/MCP wrapper + DDL + transaction semantics; no live execution.

All `file:line` citations are against `origin/main` @ `e9efe33ddde8da27222a022d80daf2746710439f`.

## The three idioms everything rides on

Unlike the bounty surface (one `idemExecute` funnel), room/membership mutations use three different idioms:

1. **Command-id dedupe in `store.command`** (`server/store.mjs:4593-4597`): keyed on `(room_id, actor_id, command.id)` in the `commands` journal; same id + same content → returns the stored `{sequence, event}` with `duplicate:true`; same id + different content → 409 `idempotency_conflict`. MCP room tools pass a client-supplied `args.id` through (`server/mcp-room-profile.mjs:627-629`), so agent callers get this for free. Caveat: several HTTP wrappers mint `randomUUID()` per call, which discards the dedupe benefit — those ops rely on idiom 3 instead.
2. **Request-ID receipt journals.** The newer member-add surfaces accept a client `requestId` and journal the result under a scope-bound key with a content fingerprint: `guest_selfserve_idem(room_id, key_hash, request_id)` (`server/guest-invites.mjs:132-141`), `guest_invites.issue_request_id` (`:467-473`), `membership_invitations` issue scope (`server/store.mjs:3233-3243`), `share_links.request_id` (`server/share-links.mjs:303-309`), `agent_connection_operations(room_id, actor_account_id, request_id)` (`server/agent-connections.mjs:193-195`), `wake_queue_commands(room_id, member_id, request_id)` (`server/wake-queue.mjs:149`). Same key + different content → 409 `idempotency_conflict`; replay → prior result with `duplicate:true`. Best-behaved surfaces here return the original result byte-identical.
3. **Natural once-only guards:** client-supplied `roomId` as the room-create key (PK lookup + content compare → `duplicate:true` / 409 `room_exists`); single-use invite burns via CAS (`UPDATE … WHERE status='active'` / `redeemed_at IS NULL` — exactly one redemption wins under concurrency); deterministic member/event ids per (identity, invite/link); `expectedMemberRevision` optimistic concurrency on `member.access_changed` (enforced in the reducer: `src/events.js:1008-1011` throws "Stale member revision"); state-machine guards on request rows (`already_decided`, `invite_not_active`).

All write transactions are `BEGIN IMMEDIATE` (`server/store.mjs:671`), so the check-then-act sequences above are race-safe in the single-process server.

## Per-op matrix

### Room create

| Op (route / tool) | Key? | Keyless double-submit | Replay w/ key | Verdict |
|---|---|---|---|---|
| `POST /api/account-rooms` | **implicit: client-supplied `roomId`** (required field; no `requestId`/`Idempotency-Key` accepted — `exact(CREATE_FIELDS)` rejects extras, `server/room-lifecycle.mjs:81-87`) | Identical retry → 200 `duplicate:true` (room-id PK hit + content compare); different content on same roomId → 409 `room_exists` (`:116-124`) | n/a (key is the roomId itself) | **yes** |
| `POST /api/account-rooms/from-template` | same (wraps `createAccountRoom`) | Room identical-retry → 200 duplicate; template seed steps use deterministic command ids (`tpl-<slug>-charter`, `-ch-<name>`, `-w-<id>`) → `store.command` dedupe replays them (`server/templates.mjs:155-183`) | n/a | **yes** |
| `POST /api/account/ensure-default-room` | n/a | Naturally idempotent: account already holding a room → 200 `{created:false}`; an account that ever held a room never resurrects one (`server/http.mjs:2073-2091`) | n/a | **yes** |
| `POST /api/agent-rooms` | **implicit: client-supplied `roomId`** ("A client-supplied roomId stays the idempotency key", `server/agent-rooms.mjs:150-152`) | With roomId: identical retry → 200 `duplicate:true` (`:180-190`); different content → 409 `room_exists`. **Without roomId: `slugFromTitle` appends a `randomBytes(2)` suffix (`:107-112`) — a retry mints a second room.** | n/a | **partial** |
| `POST /join` (+ `/room/join`, `/api/join`) — first-room branch | **no key** (`exact(joinFields)` rejects extras, `server/http.mjs:2658-2660`) | **Each retry mints a fresh random identity (`ai_`+randomBytes(12), `server/agent-identities.mjs:394`) and a fresh `personal-<identityId>` room** (`server/http.mjs:2716-2728`). The txn is atomic (no orphan identity), but the retry double-creates identity + room. | n/a | **no** |
| `room_create` (MCP) | same as `POST /api/agent-rooms` (same service path, `server/mcp-room-profile.mjs:458-464`) | same | n/a | **partial** |

### Room settings / update

| Op (route / tool) | Key? | Keyless double-submit | Replay w/ key | Verdict |
|---|---|---|---|---|
| `POST /api/rooms/{roomId}/verification-policy` | none | Blind idempotent write: boolean overwrite of `requireVerified` (`server/http.mjs:4048-4062`) | n/a | **yes** |
| `POST /api/rooms/{roomId}/public-face` | none | Blind idempotent write: boolean overwrite of `enabled` (`:4785-4793`) | n/a | **yes** |
| room title/purpose/kind update | — | **No update route exists** — there is no `ROOM_UPDATED` event type in `src/events.js`; `ROOM_CREATED` sets it and nothing mutates it. Nothing to be non-idempotent about; noted as an inventory gap. | n/a | **n/a** |

### Member add (join / invite / redeem)

| Op (route / tool) | Key? | Keyless double-submit | Replay w/ key | Verdict |
|---|---|---|---|---|
| `POST /join` (invite branch) → `store.invites.redeem` | **no key** (422 on extra fields, `server/http.mjs:2941-2955`) | Membership exactly-once: CAS burn `UPDATE … WHERE redeemed_at IS NULL AND revoked_at IS NULL`, one winner (`server/agent-invites.mjs:319-321`); same-identity re-redeem → `duplicate:true` (`:236-248`); other-identity retry → 409 `invite_already_used`. Caveat: the mcpToken is shown once — a timed-out first call strands the credential (retry gets 409, not the token). No double membership. | n/a | **partial** |
| `POST /api/agent-invites/redeem` | same (same service path) | same | n/a | **partial** |
| `POST /api/guest-invites/redeem` | **no key** | Membership once-only: deterministic seat id per identity (`guestAgentMemberId`), same-identity re-redeem → `duplicate:true`; invite burn `UPDATE … WHERE status='active'` (`server/guest-invites.mjs:556-577, :618-619`). **But every call mints a fresh credential** — a timed-out retry returns `duplicate:true` with a NEW token while the old credential stays valid (credential proliferation; no revoke on the duplicate path, `:620-633`). | n/a | **partial** |
| `POST /api/guest-invites/request` (self-serve) | **requestId** (required inside signed `joinRequest`; 422 `card_invalid` without one, `:681-683`) | True request-ID idempotency: `(room_id, key_hash, request_id)` PK lookup (`:132-141, :389-391`); identical retry → `replayed:true` metadata, **never re-issues the Bearer** (`:695-740`); new requestId → intended rotation. | replayed metadata, 200 | **yes** (caveat: no TTL on the idem table — infinite window, see cross-cutting) |
| `POST /api/share-links/join-agent` | **no key** (token is the credential) | Same identity → `duplicate:true` (`server/share-links.mjs:235-238`); deterministic member event id; `maxJoins` accounting short-circuits on the duplicate path before recording (`:142-188`) | n/a | **yes** |
| `POST /api/referral-invites/redeem` | **no key** (signed token is the credential) | CAS claim `UPDATE … WHERE jti=? AND status='minted'` (`server/referral-invites.mjs:466-469`); retry → 404 `invite_unavailable`. The identity mint sits inside the same txn, so a failed retry rolls its new identity row back — no orphan identities. | n/a | **yes** |
| `POST /api/rooms/{roomId}/agent-invites` (mint) | **no key** (`422` on extra fields, `server/http.mjs:4145`) | Each POST mints a fresh usable code (`server/agent-invites.mjs:216-229`) — retry mints a second live code. | n/a | **partial** |
| `POST /api/rooms/{roomId}/guest-invites` (mint) | **requestId** (required, `:437-442`) | Dedupe on `(room_id, minted_by_member_id, issue_request_id)`; deterministic inviteId `gx-<hash(roomId, memberId, requestId)>`; same key + different settings → the prior row is returned as `duplicate:true` (`server/guest-invites.mjs:467-488`). Code shown once by design (replay omits it — `issued(row)` without `code`, `:489-501`). | duplicate:true, 200 (no code) | **yes** |
| `POST /api/rooms/{roomId}/guest-agent-links` (mint) | **requestId** (required, `:254-257`) | Deterministic member id per `(accountId, requestId)`; live-credential check → same requestId replay returns prior issuance `duplicate:true`, different content → 409 `idempotency_conflict` (`server/guest-agent-links.mjs:278-309`) | duplicate:true | **yes** |
| `POST /api/rooms/{roomId}/share-links` (create) | **requestId** (required, `:278-281`) | Dedupe on `(room_id, issuer, request_id)` with fingerprint; same key + different settings → 409 `idempotency_conflict`; replay → `duplicate:true` (`server/share-links.mjs:301-325`) | duplicate:true | **yes** |
| `POST /api/rooms/{roomId}/agent-connections` (apply) | **requestId** (required) | Receipt journal `(room_id, actor_account_id, request_id)`; same key + different content → 409 `idempotency_conflict`; replay → prior receipt `duplicate:true`. Member events use deterministic ids `agent-<hash(accountId:requestId)>`, giving a second layer via `store.command` dedupe (`server/agent-connections.mjs:173-280`) | duplicate:true | **yes** |
| `POST /api/rooms/{roomId}/invitations` (`issueInvitation`) | **requestId** (required, `server/http.mjs:4912-4923`) | Dedupe scope follows the issuer (account-scoped or member-scoped partial index, `server/store.mjs:3233-3243`); content fingerprint; same key + different scope → 409 `idempotency_conflict`; replay → prior invitation `duplicate:true` (`:3236-3243`) | duplicate:true | **yes** |
| `POST /api/access-requests` (file) | **requestId** (optional; service mints one if omitted — "requestId is your idempotency key — reuse it when retrying", `server/http.mjs:3078`) | Same requestId → returns the original request, "retry never emits a duplicate" (`server/access-requests.mjs:169-285`); conflicting principal on same requestId → 409 `request_conflict` (`:205`). Caveat: caller that omits requestId gets a fresh random one per call → keyless retry files a second request. | original request, 200 | **yes** |
| `POST …/access-requests/{id}/decide` | n/a (state guard) | Retry → 409 `already_decided` once the row left `pending` (`server/access-requests.mjs:633`). The permission-upgrade approve path additionally fails `stale_membership` if the member changed (`server/member-permission-requests.mjs:99-117`); deny path is a bare status UPDATE (`access-requests.mjs:643-648`). | n/a | **yes** |
| permission-upgrade request (member) | **requestId** (optional, minted if omitted) | Same requestId → returns the existing request; conflicting scope → 409 (`server/member-permission-requests.mjs:37-64`) | existing request | **yes** |

### Member remove (leave / deactivate / revoke)

| Op (route / tool) | Key? | Keyless double-submit | Replay w/ key | Verdict |
|---|---|---|---|---|
| `DELETE /api/rooms/{roomId}/member-deactivate` (self-leave) | none (fresh `randomUUID()` event id per call, `server/http.mjs:4469-4472`) | **Safe without a key:** after success the credential no longer authenticates, so a retry 401s before reaching the write ("a second DELETE never reaches here", `:4466-4468`). Race: two concurrent DELETEs serialize in the txn; the second's reducer throws "Stale member revision" (`src/events.js:1011`) and the txn rolls back. No double deactivation. | n/a | **yes** |
| `POST …/guest-invites-revoke` | n/a | Retry → 409 `invite_not_active` (`server/guest-invites.mjs:891-900`) | n/a | **yes** |
| `POST …/guest-invites-disconnect` | none | Retry → 404 `guest_not_found` (member already inactive, `:906-927`); race-safe via txn + reducer revision check | n/a | **yes** |
| `POST …/guest-invites-revoke-all` | none | Skips inactive members; retry returns `revoked:0` (`:928-962`) | n/a | **yes** |
| `DELETE …/agent-invites` (revoke) | n/a | Retry → 404 `invite_unavailable` (already revoked, `server/agent-invites.mjs:391-398`) | n/a | **yes** |
| `DELETE …/agent-grant-delete` (`revokeAgentGrant`) | n/a | Conditional UPDATE `… WHERE revoked_at IS NULL` → retry returns `{revoked:false}` with no change (`server/grants.mjs:181-190`); the route is even annotated "Idempotent" (`server/http.mjs:4276-4279`) | n/a | **yes** |

### Role change (permissions / grants / ownership)

| Op (route / tool) | Key? | Keyless double-submit | Replay w/ key | Verdict |
|---|---|---|---|---|
| `POST …/delegation-grant` | none (`exact(["identityId"])`) | Retry → 409 `grant_active` before any write; re-grant after revoke is an UPDATE, not an INSERT (`server/membership-delegation.mjs:38-91`). The `member.access_changed` event inside is unreachable on retry (guard precedes it). | n/a | **yes** |
| `POST …/delegation-revoke` (`revokeEffective`) | none | Retry → 404 `not_found`; the permission-strip command is skipped when the diff is empty, so no duplicate `member.access_changed` events (`:187-233`) | n/a | **yes** |
| `POST …/owner-delegate-grant` | none (`exact(["identityId"])`) | Retry → 409 `grant_active` (`server/owner-delegates.mjs:64-98`) | n/a | **yes** |
| `POST …/owner-delegate-revoke` | none | Retry → 404 `not_found` (`:99-119`) | n/a | **yes** |
| `POST …/ownership-transfer` | none (fresh `randomUUID()` command id) | **Safe without a key:** after a successful transfer the caller is no longer owner, so a retry fails the in-txn owner check (`server/agent-rooms.mjs:248-249`) with 403 `owner_required`; concurrent transfers serialize (`BEGIN IMMEDIATE`) and the loser's owner check reads post-commit state. | n/a | **yes** |
| `POST …/agent-pause` (pause/resume) | **requestId** (required, `server/http.mjs:4515-4516`) | Request-ID receipt journal `wake_queue_commands(room_id, member_id, request_id)` with content fingerprint; replay → prior receipt `duplicate:true` (`server/wake-queue.mjs:145-243`) | duplicate:true | **yes** |
| `POST …/guest-invites-upgrade` | none | Same tier → `{unchanged:true}`; tier change goes through an `expectedMemberRevision`-guarded `member.access_changed` (`server/guest-invites.mjs:964-1001`) | n/a | **yes** |
| MCP command tools (room membership mutations) | client `args.id` | `store.command` dedupe on `(room_id, actor_id, command.id)`; same id + different content → 409 `idempotency_conflict` (`server/store.mjs:4593-4597`, `server/mcp-room-profile.mjs:627-629`) | duplicate:true | **yes** |

## Cross-cutting findings

1. **Three idioms, no uniform `Idempotency-Key` header.** Unlike bounties (one `idemExecute`), the membership surface mixes command-id dedupe, request-ID receipt journals, and natural guards. The newest member-add surfaces (`guest-invites` mint, `guest-agent-links` mint, `share-links` create, `agent-connections` apply, `invitations`, `agent-pause`) all REQUIRE `requestId` and fingerprint replays — this is the emerging convention. The older surfaces (`agent-invites` mint/redeem, `POST /join`) still accept no key and degrade to natural guards only.
2. **`store.command`'s dedupe is discarded by server-minted UUIDs.** `member-deactivate`, `ownership-transfer`, `delegation-grant`'s inner permission event, and permission-upgrade approvals all call `store.command` with `id: randomUUID()`, so the `(room_id, actor_id, command.id)` replay mechanism never fires for them — each happens to be safe anyway (credential death, lost ownership, 409/404 guards), but the mechanism is not doing the work.
3. **No TTL/pruning on any idempotency record.** `guest_selfserve_idem` (`server/guest-invites.mjs:132-141`) stores `(room_id, key_hash, request_id)` forever — rows die only on room purge. Same infinite-window property B4 found in `bounty_idempotency`; growth is bounded here by key-hash cardinality (one row per (key, requestId) pair), so this is a minor note, not a hole.
4. **One-shot secrets are the standard recovery tax.** Guest-invite codes, issued guest-invite `code`, redeem-time Bearer <redacted> / mcpToken, and rotated guest tokens are all shown exactly once. Every "partial" verdict in this audit is the same shape: the membership write is once-only, but a client that times out before reading the secret cannot recover it by retrying — the retry returns `duplicate:true`/409 without the secret. This is deliberate (Burs-IA review on the self-serve path: `server/guest-invites.mjs:695-700`), but it means keyless-retry clients can strand a just-created membership with no credential.
5. **Room config is nearly immutable.** Title/purpose/kind have no update route at all; the only post-creation room-settings mutations found are the two boolean overwrites (`verification-policy`, `public-face`), both blind-idempotent. If a room-settings edit route is added later, it should take `requestId` like the newer membership surfaces.

## Worst finding (for B11)

**`POST /join` (first-room branch) double-creates an identity AND a personal room on keyless retry** (`server/http.mjs:2716-2728`). Repro: a cold client POSTs `{displayName}` without an invite code, times out before reading the 201, retries with the same body → the route accepts no `requestId` (`exact(joinFields)` rejects extras at `:2658-2660`), mints a fresh random identity (`ai_`+`randomBytes(12)`, `server/agent-identities.mjs:394`), and `agentRooms.create` derives a fresh `personal-<identityId>` room — so the retry creates a second identity + second room. The txn is atomic (no orphan identity), rate limiting bounds the blast radius, but the user now owns two rooms and two identities with no way to know the first succeeded. Fix direction (for B11, not this audit): accept an optional client `requestId` on the `/join` body and journal it against `(address, requestId)` or the PoW proof before minting — the same receipt-journal idiom the newer membership surfaces already use — or make the first-room branch derive the identity deterministically from a client-supplied key.

Runner-up: `POST /api/agent-invites` (mint) double-mints usable codes on retry (`server/agent-invites.mjs:216-229` — the one mint surface that never got the `requestId` treatment its guest counterpart has).

## Verdict summary for the B1 matrix

- **yes:** POST /api/account-rooms, from-template, ensure-default-room, verification-policy, public-face, share-links/join-agent, referral-invites/redeem, guest-invites mint, guest-agent-links mint, share-links create, agent-connections apply, invitations (issueInvitation), access-requests file + decide, permission-upgrade request + decide, member-deactivate, guest-invites revoke/disconnect/revoke-all, agent-invites revoke, agent-grant-delete, delegation grant/revoke, owner-delegate grant/revoke, ownership-transfer, agent-pause, guest-invites-upgrade, MCP command tools, guest-invites/request self-serve (with infinite-window note).
- **partial:** POST /api/agent-rooms + MCP room_create (client roomId is the key; omitted roomId → random slug suffix → second room), POST /join invite branch + /api/agent-invites/redeem (CAS-burn once-only membership, but no key and one-shot token), POST /api/guest-invites/redeem (once-only membership, but every call mints a fresh credential), POST /api/rooms/{roomId}/agent-invites mint (no key; retry mints a second live code), access-requests file without requestId (service-minted random id per call).
- **no:** `POST /join` first-room branch without inviteCode — keyless retry double-creates identity + personal room (the single double-write path in the room/membership surface).
- **n/a:** room title/purpose/kind update — no such mutation exists.

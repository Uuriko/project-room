# room-aux-set — module notes (WAVE-400 code archaeology)

Four small server modules around room orientation and safety rails:
`server/room-activation-pack.mjs` (183 lines), `server/room-assistant.mjs` (209 lines),
`server/room-key-presence.mjs` (56 lines), `server/room-flood-guard.mjs` (32 lines).

---

## 1. server/room-activation-pack.mjs

**Purpose.** Builds a single machine-readable "activation pack" so a newly arriving agent
can start working in a room without a dozen round trips: roster, open work with claim
state, pinned resources, owner-set policy, coordination norms, and an opaque event-log
cursor. It is a read-only projection over the store; unknown rooms surface the store's
own 404 (`room_not_found`).

**Public API.**
- `buildActivationPack(store, roomSlug, viewerId = null)` → pack object. Throws
  `Room projection is missing its room record` when `store.room()` has no room record.
  Appends a per-member `pack.orient` (from `buildOrient`) only when `viewerId` is a string
  naming a current member.
- `COORDINATION_NORMS` — frozen object `{ maxClaimsPerAgentPerCycle: 1, releaseOnInactivityHours: 24, stopAfterRepeatedNoopWakes: true }`. Copied per pack so callers can't mutate the shared ref.

**Behavior notes.**
- Open work = items in `proposed|accepted|working|blocked`, oldest first; completed/superseded excluded.
- Pins are filtered by `messageVisibleToViewer` with the viewer's summary history floor, so a viewer never sees pins they can't read (QA4 Q4-SEC-1; supersedes the older pinVisibleToViewer audit fix F-1).
- `claimStatusOf` derives claim status from `expiresAt` vs `nowIso` (via `store.now()`): missing claim → `null`; `released` → `"released"`; otherwise `"active"` iff `expiresAt` is in the future, else `"expired"`.
- `eventCursor` is `base64url(JSON({v:1, seq: sequence}))` — opaque to clients, self-describing to the server.
- `contentTrust` wrapper marks member-authored text as data, not instructions (`withContentTrust`).

**Top callers.**
- `server/http.mjs:4019` — `GET /api/rooms/:slug/activation-pack`.
- `server/mcp-room-profile.mjs:493` — MCP tool `room_activation_pack` (passes `auth.member.id` as viewer).

**Invariants.**
- Read-only: never writes to the store or DB.
- All member-authored strings in the pack carry `untrusted: true` (or `markAlways` via `annotateOrientation`); the pack must never be treated as instructions.
- Unknown room → store's 404, never a partial pack.
- `COORDINATION_NORMS` stays frozen and is copied, not aliased, into each pack.

**Gotchas.**
- The pack has both `orientation` (shared browser-overview shape) and, for member viewers, a sibling top-level `orient` (from `buildOrient`, `{ text: false }`) — two similarly-named fields with different shapes. The schema docstring documents `orientation` only; `orient` is undocumented (see Stale comments).
- `claimStatusOf` has no NaN guard: a claim with a missing/unparseable `expiresAt` reports `"expired"` rather than `"active"`. In-store claims always carry `expiresAt`, so this is latent, not live.
- The trust label on orientation (`owner` vs `untrusted`) comes from `purposeSource.kind` (`instructions`|`room` → owner); anything else is `untrusted`.

**Stale comments.**
- None in code logic. Doc gap only: the big schema comment at the top (lines ~19–66) does not mention the `orient` field appended at build time (line ~170) when `viewerId` is a member.

---

## 2. server/room-assistant.mjs

**Purpose.** The shared-assistant coordination contract: one room member (a human) asks,
one configured coordinator agent (with `accept_work`) hosts the execution, and humans
contribute/resolve scope — all with optimistic-concurrency revisions, idempotent
request IDs, and host-liveness detection. Tables (`room_assistant_config`,
`room_assistant_runs`, `room_assistant_ops`) are created idempotently via `init()` and
stored JSON-in-TEXT.

**Public API.**
- `new RoomAssistant(store)` — `init()` creates the three tables.
- `config(roomId)` → `{ name, coordinatorMemberId, revision }`, or `{ name:'Room', coordinatorMemberId:null, revision:0 }` when never configured.
- `list(roomId, authorize)` → `{ contractVersion: 1, roomId, assistant: {...config, availability}, runs }`. Never mutates storage (explicit fresh-install early return). `availability` is `not_connected` (no coordinator or coordinator lacks `accept_work`), `awaiting_host` (coordinator configured but no heartbeat within 120s), or `connected` (heartbeat ≤120s and run non-terminal). Runs whose source message is invisible to the viewer are dropped unless `controlsDeletedSource` applies (then a redacted `deletedControl` stub is shown). A `working` run with no heartbeat in 120s is relabeled `unknown`.
- `apply(roomId, input, authorize)` → dispatches one action; all writes run inside `store.transaction()` and are idempotency-keyed on `(roomId, actorId, requestId)`.

**Actions (the `keys` whitelist also enforces exact key sets per action).**
- `configure` — owner only; requires matching `expectedRevision`; name 1–64 chars; coordinator must be an active agent member with `accept_work` (or `null` to disconnect). Coordinator change pauses non-terminal runs (no-attempt runs get the new coordinator id; working runs → `pause_requested`); every touched run's `revision++`.
- `invoke` — human only; source must be the caller's own visible shared message; requires a connected coordinator; one run per source message (409 `assistant_run_exists`); creates a `queued` run.
- `contribute` — human only; appends a shared input (max 100); `conflict: true` flips run to `needs_input`.
- `resolve` — human only, and only the requester or owner; requires status `needs_input`; clears to `pause_requested` (if host claimed) or `queued`.
- `claim` — the configured coordinator agent only; requires `queued`, no existing `attemptId`, and the coordinator not being pause-requested (`wakeQueue.pauseStatus`); sets `attemptId`, status `working`, `hostReportedAt`.
- `report` — the reserved host only; validated state machine for `working|needs_input|paused|cancelled|done|failed` with stop-acknowledgment rules (`cancel_requested`→must report `cancelled|failed`, `paused`→must not go back to `working`, etc.); `done` requires a published result message (must be the reporter's own visible message) and every human input marked `applied` (via `appliedInputMessageIds`), else 409 `assistant_inputs_pending`. Activity log capped at 100 entries.
- `pause` / `cancel` — human requester or owner; without a host attempt they flip to `paused`/`cancelled` immediately, with one they become `*_requested`.
- `resume` — human requester or owner; requires status `paused` and the *original* configured coordinator to be connected; sets `resume_requested` or `queued`.

**Top callers.**
- `server/routes/room-assistant.mjs` — `GET/HEAD/POST /api/rooms/{roomId}/assistant` (list on read, apply on POST).
- `server/mcp-full-profile.mjs:199` — MCP `room_assistant_context` (list) and the other assistant tools (apply), with `store.authenticate(secret, roomId)` as `authorize`.
- `server/routes/table.mjs` — wires `ROOM_ASSISTANT_ROUTES` into the route table.
- `server/store.mjs` — executes `roomAssistantSchema` in the schema bundle (line 1059, 1736).

**Invariants.**
- Guests (guest member ids or `guest:*` permissions) can never use assistant coordination (403).
- Archived rooms refuse all assistant writes.
- Deleted source messages leave only a stop handle (`deletedControl`): only the initiator/owner (human) or the coordinator (agent) may pause/cancel/report-terminal on them, and reads return the redacted stub.
- Request-ID idempotency: same `(roomId, actorId, requestId)` + same canonical input replays the stored response; different input → 409 `assistant_retry_conflict`.
- Revision conflicts fail with `assistant_revision_conflict` before any mutation.
- A run can never report `done` while any human contribution is unapplied, and `claim` requires the run to be `queued`.

**Gotchas.**
- Host liveness is heartbeat-based with a hardcoded 120s threshold (appears twice in `list()`); a silently dead host shows as `unknown`, not failed — recovery is human-driven (`pause`/`cancel`).
- Changing the coordinator does not transfer `attemptId` runs: old attempt stays reserved until the old host reports terminal; the new coordinator cannot `claim` until then.
- `enforceAutonomyTierForAction` runs on every coordinator `claim`/`report` — autonomy-tier failures fail the op even if the state machine is happy.
- The `list()` "fresh install" check returns early without initializing tables; `apply()` calls `this.init()` before anything else.
- Activity entries and `appliedInputMessageIds` both cap at 100; the 101st contribution is rejected with `assistant_input_limit`.

**Stale comments.**
- The `// Fresh installations have no configuration; reads must not mutate storage.` comment in `list()` is accurate (early return before `this.init()`).
- The autonomy-tiers enforcement comment ("A current revision alone does not establish that the host handled every human contribution…") is accurate and documents a real invariant.

---

## 3. server/room-key-presence.mjs

**Purpose.** Lets a *saved room access key* (the seat a host already uses to read/post) register pull-only presence for its own agent member, so a mention can queue a wake on the existing heartbeat path — without installing wake URLs, push subscriptions, or replacing a wakeable host the identity secret registered.

**Public API.**
- `roomKeyPresenceAuth(store, secret)` → `{ identityId, roomId, hostPrefix }` or throws 401/403. Refuses unless: bearer is a room access token (`isRoomAccessToken`), credential scope is `room`, kind is `access`, member kind is `agent`, the member is a linked identity (`identityIdForMember` matches `member.identityId`), AND that identity is linked to this room alone (exactly one `(roomId, memberId)` row). `hostPrefix` is `rk_<sha256(secret) hex>_`.
- `assertRoomKeyPullOnly(store, identityId, data)` → throws 403 `room_key_wake_refused` unless `data.mode === "pull-only"` and both `wakeUrl` and `pushNotification` are null/absent; also refuses when an existing host with the same hostId is `wakeable` or a push config exists for `(identityId, hostId)` — a room key can never upgrade/downgrade a host registered by the identity secret.
- `roomKeyHostId(auth, hostId)` → `auth.hostPrefix + sha256(hostId).slice(0,48)`; validates `[A-Za-z0-9._-]{1,128}` (422 `invalid_heartbeat`). Credential-derived ids can't collide with identity-owned host names by choosing the public name.
- `roomKeyPresenceView(store, auth)` → `{ agentId, hosts, lastSeenAt, status }` over `store.agentHeartbeats.statusOf(identityId).hosts`, filtered to the caller's `hostPrefix` and `mode === "pull-only"`, with `wakeUrl` nulled. Status: `online` if any host online, else `offline`, else `unregistered`. No credential is stored or returned.

**Top callers.**
- `server/agent-plugin-routes.mjs` — heartbeat/auth plumbing (lines 101, 791, 805–807, 842, 889).

**How key presence is tracked.** Presence itself lives in `store.agentHeartbeats` (the same heartbeat store identity secrets use). A room key's hosts are namespaced by the per-secret `hostPrefix` so one key cannot mark other seats online; a multi-room identity is rejected outright so one key can't light up every room. The view is a projection: pull-only hosts under this key's prefix, wake URLs redacted.

**Invariants.**
- Pull-only only: no wake URL, no push subscription, ever, via a room key.
- Never replaces a `wakeable` host or a host with a push config (checked twice in the heartbeat path: once with the raw `data.hostId`, once with the namespaced `roomKeyHostId`).
- Identity must be linked to exactly one room/member pair; unlinked or multi-room members are refused.

**Gotchas.**
- `roomKeyPresenceView`'s `lastSeenAt` is `hosts[0]?.lastSeenAt` — the filtered array is *not* sorted, so this is an arbitrary host's timestamp, not the max (see bugs file).
- The prefix embeds `sha256(secret)` in hex; two keys for the same seat get disjoint host namespaces, and revoking the key leaves orphaned heartbeat rows until TTL.

**Stale comments.** None found — the header comment accurately describes the scope and the multi-room guard.

---

## 4. server/room-flood-guard.mjs

**Purpose.** A per-(room, member) token bucket bounding live chat posts so one looping member — human or agent — cannot fill a room. In-memory only; no tiers, no counters surfaced, budget resets when the process is evicted.

**Public API.**
- `createRoomFloodGuard({ now, capacity = 30, refillPerSecond = 0.5 } = {})` → `{ consume(roomId, memberId, commandType) }`.
- `consume(roomId, memberId, commandType)` — no-op unless `commandType` is `message.posted` or `dm.posted` (a reply is `message.posted` with `replyToId`); no-op on non-string/empty ids. On budget exhaustion throws `ServiceError(429, "rate_limited", "on 429, wait Retry-After and retry", { "Retry-After": "<ceil seconds>" })` and also sets `error.retryAfterMs`.

**How flood-guard thresholds work.** Delegates to `createRateLimiter` in `server/identity-ratelimit.mjs`: one bucket per `roomId:memberId` key, capacity 30 (burst), refill 1 token per 2 seconds (`refillPerSecond = 0.5`). Buckets are lazily created full; refill is time-based (`elapsed * refillPerSecond`, capped at capacity). The underlying map is LRU-bounded at 2000 keys — a flood of distinct `(room,member)` keys evicts the oldest buckets (resetting their budgets), never denying everyone. There are no per-member tiers and no runtime tuning knobs; thresholds are fixed at construction (`store.mjs:1179` constructs with defaults).

**Top callers.**
- `server/store.mjs:1179` — constructs the single guard; `server/store.mjs:4574` — `store.command()` calls `consume` after the idempotency replay (so replays are free) and before `dmConsents`/archived checks. Only `message.posted`/`dm.posted` spend a token; reactions, edits, deletes, reads, work/claim commands do not. System writes, `importEvents`, and projection replay never call `consume`.

**Invariants.**
- Only live chat posts/replies are charged; idempotent command replays are free (consume happens after the replay check).
- 429s always carry `Retry-After` (ceil seconds, minimum 1) plus `retryAfterMs` on the error.
- Budget is per `(room, member)` pair, so a flood in one room never affects another room or member.

**Gotchas.**
- In-memory: eviction or process restart wipes all budgets (documented in the header).
- The guard is checked *after* guest-scope and idempotency checks but *before* archived-room refusal and DM-consent — a 429 can fire for a room where the write would have been refused anyway.
- Malformed `roomId`/`memberId` fail open (silent return) rather than throwing — by design (defensive), but worth knowing.

**Stale comments.**
- Line 5–6 header: `"There are no tiers, no settings, and no counter."` is stale. There ARE settings (`capacity` and `refillPerSecond` constructor params, defaults 30 / 0.5), and the underlying `createRateLimiter` exposes `.state()`, `.capacity`, and `.refillPerSecond` — effectively a counter/inspection API.
- The header's `"store.command returns an idempotent replay before consume, so that command id is free"` is accurate (verified at `server/store.mjs:4565–4574`).

---

## Cross-cutting notes

- `room-assistant.mjs` and `room-key-presence.mjs` both rely on `store.agentHeartbeats` / `wakeQueue` for liveness, but measure it differently: the assistant uses heartbeat recency (`hostReportedAt` ≤120s in `list()` and on `claim`), while key presence filters by host mode and the secret-derived prefix.
- The activation pack's `openWork` and the assistant's `runs` are separate claim/work models: pack reads projection work items; assistant tracks host-execution runs in its own tables. An agent starting from a pack gets work state but no assistant-run state (and vice versa).

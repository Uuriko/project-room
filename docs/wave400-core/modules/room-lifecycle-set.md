# room-lifecycle-set — module notes (WAVE-400 code archaeology)

Files: `server/room-lifecycle.mjs` (169 lines), `server/room-context.mjs` (151 lines), `server/room-guide.mjs` (176 lines).

---

## 1. `server/room-lifecycle.mjs`

**Purpose.** Owns the room lifecycle on the server side: the `rooms.archived_at` column (schema v28), its migration/audit, and the account-level `createAccountRoom` command. Lifecycle state itself lives in the event-sourced projection (`room.archivedAt` set by the owner-only `room.archived` event); this module keeps the SQL-visible column in sync so discovery and recovery can read it without decoding projections.

**Lifecycle state diagram.** There is no formal state machine in this file; the states are implicit:

```
(nonexistent) --createAccountRoom--> active --room.archived event (owner-only)--> archived
     ^                                    |
     |                                    | reads / streams / export stay available
     |                                    v
     +-- client-supplied roomId re-POST --> returns same room, duplicate: true (409 room_exists if not identical)
```

- Archive closes all writes: `refuseArchivedWrite` guards commands, history import, and join paths that append membership events. Reads, streams, and export stay open.
- Leaving a room needs nothing here: the existing `member.access_changed` event targeted at the actor ends membership (reducer allows a member to end their own access).
- `rooms.archived_at` is a derived column: `migrateRoomLifecycleV28` backfills `json_extract(projection,'$.room.archivedAt')`; `verifyRoomLifecycle` refuses startup if column and projection disagree ("requires operator reconciliation").

**Public API.**

| Signature | Behavior |
|---|---|
| `migrateRoomLifecycleV28(store)` | Idempotent data backfill: adds `archived_at` column if missing, syncs it from every projection. Version-neutral by design; never touches `PRAGMA user_version`. |
| `verifyRoomLifecycle(store)` | Startup audit (writable and read-only opens): throws if the column is missing or any row disagrees with its projection. Read-only never migrates or repairs. |
| `refuseArchivedWrite(state)` | Throws 409 `room_archived` if the room state is archived; called by every write path. |
| `archivedAtOf(state)` | Returns `state.room.archivedAt` if a string, else `null`. Used when persisting the column. |
| `createAccountRoom(store, token, binding, request)` | Creates a room owned by an account: validates the request (exact field set + optional starter fields), enforces the 100-room pilot cap, checks the "administers membership somewhere OR first room OR growth credits" gate, then appends `ROOM_CREATED` + `MEMBER_ADDED(owner)` events and binds the account. Idempotent on client-chosen `roomId`. |
| `ACCOUNT_ROOM_SELECT` / `accountRoomEntry(row, memberId)` | SQL + row→view mapper for the account's room list (`{id, title, memberId, kind, archived, archivedAt}`). |
| `ROOM_LIFECYCLE_MIGRATION = 28`, `ACCOUNT_ROOM_LIMIT = 100` | Constants. |

**Invariants.**
- Column and projection always agree; `verifyRoomLifecycle` fails the open if not (fail-closed, never auto-repair on read-only).
- Archived ⇒ no new writes of any kind (commands, history import, membership events); reads unaffected.
- Room creation eligibility: (a) account has zero memberships → first room allowed; (b) account administers (owner or `manage_members` in an active human membership) → allowed; (c) otherwise needs spare growth-loop credits (`foundedWithGrowth`), and growth-funded rooms never count as administering. Provisional (room-key) accounts can never create rooms.
- Idempotency: same `roomId` + identical title/purpose/kind/displayName/owner ⇒ returns the existing room with `duplicate: true`; anything different ⇒ 409 `room_exists`.

**Top callers.** `server/store.mjs` (imports everything; `RoomStore.createAccountRoom` is a thin wrapper; migration wired at store.mjs:1455, verify at :1302/:1808/:1879, `archivedAtOf` at :2736/:4110/:4785, discovery list at :3143); `server/http.mjs` (POST create-room route :2056, template flow :2085); `server/templates.mjs` (:155); the seven `refuseArchivedWrite` users — `agent-invites.mjs`, `guest-invites.mjs`, `referral-invites.mjs`, `share-links.mjs`, `squads.mjs`, `store.mjs`.

**Gotchas.**
- `archived_at` must never be written directly by other modules — it is a *copy* of the projection; the projection is the source of truth. `archivedAtOf` is the only write-side helper.
- Schema-version bookkeeping lives ONLY in `writer-fence.mjs` (`STORE_SCHEMA_VERSION`); this module is deliberately version-neutral and must not touch `PRAGMA user_version`.
- `createAccountRoom` authenticates per membership candidate inside `.some()` and swallows only 403 (inactive rooms) — any other auth error aborts creation. `activeMemberships` counts only rooms where auth succeeded.
- The 409 `room_exists` path also fires when the id belongs to a room this account isn't bound to (`bound` null ⇒ `same` null).

**Stale comments.**
- None found. Header accurately describes schema v28, the projection-as-source-of-truth split, and the version-neutral migration stance. `PRIV-2` and `ACT-1a` tags are live work-item references.

---

## 2. `server/room-context.mjs`

**Purpose.** Builds one compact, authenticated "catch-up" projection of a room for an agent: who is here (roster), the room's policy, work aimed at the viewer (`focusWork`), active claim locks, dependency links, decisions, file/evidence refs, live work-item sessions, and an open handoff triaged to the viewer. Message bodies, file bytes, and result prose are deliberately excluded; `context_version` (sha256 over a canonical serialization of the structural projection) lets callers send `sinceVersion` and get `{ not_modified: true }` back when nothing structural changed.

**Lifecycle state diagram.** None — this module is a pure read projection. The not-modified protocol is: `store.roomContext(token, roomId, { sinceVersion })` (server/store.mjs:4231) returns the full context, or `{ not_modified: true }` when `sinceVersion === built.context_version`. Clock-derived fields (`evaluatedAt`, session staleness, heartbeat times) are excluded from the hash so the clock alone never invalidates it.

**Public API.**

| Signature | Behavior |
|---|---|
| `buildRoomContext({ state, sequence, viewerId, caughtUp, now })` | Pure projection; throws `RangeError` on bad input. Returns `{ contractVersion: 1, context_version, evaluatedThrough, evaluatedAt, cursors, roomId, viewerId, roster, policy, focusWork, locks, deps, liveSessions, handoffToYou, decisions, fileRefs, omitted }`. |
| `contextVersion(stable)` | sha256 hex of the canonical JSON of the stable projection. |
| `ROOM_CONTEXT_OMITTED` | Frozen list of field names deliberately left out (`message_bodies`, `file_bodies`, `native_result_text`, `definition_of_done`, `handoff_done_summary`, `decision_reason`). Echoed in every response so clients know what they aren't getting. |

**Invariants.**
- Bodies stay out: `ROOM_CONTEXT_OMITTED` is part of the contract, echoed as `omitted` in every response.
- Determinism: every list is sorted by stable key before hashing (roster by member id, work lists by workItemId, fileRefs by a composite NUL-joined key), so equal rooms hash equal.
- Staleness is not hashed: live-session heartbeat times and the service clock do not feed `context_version`; "Heartbeat time is structural" — a missing/old heartbeat makes a session takeable under `sessionWorker`, but does not flip the hash.
- Viewer-scoping: `focusWork` only includes items where the viewer is the next actor or the claim holder; `handoffToYou` only the latest open handoff triaged to the viewer (falls back to room owner when `triageMemberId` is unset).

**Top callers.** `server/store.mjs` only (production): `roomContext` at :4238. Tests: `tests/room-context.test.js`.

**Gotchas.**
- `caughtUp` (the viewer's read cursor) is required and validated as a safe integer; `now` must be the same service clock the claim system uses, or lock-expiry/focus computations drift from what `activeClaim`/`nextWorkStep` decide elsewhere.
- `policy` merges two sources: `requireIndependentReview`/`requireOwnerDecision` from `roomPolicy(state)` and `revision` from the stored policy blob, defaulting to 0 — a room with no policy record reports revision 0, not "absent".
- `canonical()` is a hand-rolled canonicalizer (sorted object keys). `evaluatedAt`, `cursors`, and the identity block are added *after* hashing, by construction.

**Stale comments.**
- None found. The "SESSION_HEARTBEAT_STALE_MS (10 minutes)" reference is to `src/work-item-session.js`, where the constant lives — accurate. The not-modified semantics described match `store.roomContext`.

---

## 3. `server/room-guide.mjs`

**Purpose.** The Room Guide is a deterministic demo agent (ACT-1a; no LLM calls): after a starter room is seeded, it posts the welcome message with starter choices, claims the `starter-receipt` claim, closes it when the newcomer picks a choice, and assigns the chosen starter work to the first real agent that joins. It goes inert permanently once a real agent is assigned (ACT-4 owns later nudges). Pure state-machine stepping — one stage per `runGuideStep` call.

**Lifecycle state diagram.** Implicit, driven by `step()` — one stage per call:

```
starter room seeded (state.room.starterSeeded)
  └─ no welcome message yet  ──> "seeded": post welcome + claim starter-receipt (if unclaimed)
  └─ choice picked (message body matches a starter-choice id/title) and starter owned by guide
      ──> "choice_made": claimed → in_progress → done (note "choice:<id> <title>")
  └─ starter done, first real agent joined, chosen claim unclaimed
      ──> "agent_joined": claim chosen work for agent, post @mention, enqueueClaimWake
  └─ else: null (inert — archived room, guide inactive, no registry, no starter seed)
```

**Public API.**

| Signature | Behavior |
|---|---|
| `installGuideCommandHook(store)` | Monkey-patches the store prototype's `command` (once, via `__roomGuideHook` flag) so every command in a room notes the room and runs a guide step after the command returns; guide failures are caught and logged, never fail the caller. |
| `flushRoomGuide(store)` | Called by `cloudflare/room.mjs` from the post-request flush; advances rooms queued by commands where the hook didn't (or couldn't) run the step. A step that threw stays queued. |
| `runGuideStep(store, roomId, now = Date.now())` | Runs one guide stage inside its own store transaction; returns `"seeded"`, `"choice_made"`, `"agent_joined"`, or `null`. Guards on `store.db`/`room`/`transaction` presence. |
| `ROOM_GUIDE_ID`, `WELCOME_BODY`, `STARTER_CLAIM_ID` | Re-exported guide member id, the welcome message text, the `"starter-receipt"` claim id. |

**Invariants.**
- Guide is inert unless the room has `starterSeeded`, is not archived, and the guide member exists and is active.
- Exactly one stage per call: welcome+claim, or choice close, or assignment — never two.
- Welcome and assignment messages are idempotent via stable message ids (`gw-<roomId>`, `stableEventId("ga", roomId\0agentId)`); re-runs find the existing message and move on.
- A failed step never fails the triggering command (try/catch + console.error in both hook and flush paths).

**Top callers.** `cloudflare/room.mjs` (:100 installs the hook in the Durable Object constructor; :193 flushes post-request); `server/starter-room.mjs` (:65 installs on seed, :115 steps immediately); `tests/starter-room.test.js`.

**Gotchas.**
- The hook patches the *prototype*, so it applies to every store instance of that class and installs at most once per process. `pending` is a `WeakMap` keyed by store instance, so two store instances never share a queue.
- Timing subtlety: the hook runs the guide step *after* `command` returns (i.e., inside the command's post-return window) — the guide writes happen in the step's own transaction, not the command's. Node tests rely on this so they don't have to edit `server/store.mjs`.
- `pickedChoice` matches a message body against choice id *or title* and skips the guide's own messages and receipt cards — a user literally typing a choice title (or id) is the entire UI. Body must be a string.
- `choiceIdFromItem` recovers the chosen id from the done-stamp note `choice:<id> <title>` — the id is everything up to the first space.

**Stale comments.**
- `server/room-guide.mjs:52-54` (in `installGuideCommandHook`): "The wrapper runs after RoomStore.command returns and before that transaction commits, so node tests see the step without editing server/store.mjs." Self-contradictory — once `command` has *returned*, its transaction has committed; the step actually runs afterward in its own transaction via `runGuideStep` → `store.transaction(...)` (line 173). The operational effect (tests see the step; no store.mjs edits) is correct, but the "before that transaction commits" clause is wrong and should say the step runs after commit in a separate transaction.

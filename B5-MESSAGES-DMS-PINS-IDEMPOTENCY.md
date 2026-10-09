# B5 — Idempotency audit: messages / DMs / pins

**Worker:** PRODUCT-200 reliability B5/50 · **Coordinator:** product200-reliability (claim registered)
**Scope:** every mutating operation reachable from message/DM/pin write paths
(`POST /api/rooms/:id/commands` → `store.command`, `POST /api/rooms/:id/pins`,
DM-consent routes), the `commands` dedupe table, and the reducers in `src/events.js`.
Read-only audit — no code changed.
**Base:** `origin/main` @ `dbdd088bd`.

## Headline

| Rank | Finding | Verdict |
|---|---|---|
| **WORST** | Retry-after-timeout with a regenerated command id **duplicates the message** — message identity is a fresh randomUUID per `command()` call, never derived from the idempotency key. | F1 — feed to B11 |
| 2 | History import (`POST /import`) wipes the whole `commands` table → any client retry after an import re-appends. | F2 |
| — | Everything else audited is retry-safe (pins, edits, deletes, reactions, DM consents, thread mutes). | — |

## Dedupe mechanism (shared by all command-path writes)

- `store.command` (server/store.mjs:4569) runs in **one transaction**: dedupe SELECT → validate → reducer → `INSERT INTO events` + `INSERT INTO commands` (server/store.mjs:4839) atomically.
- Dedupe key: `(room_id, actor_id, command.id)` — `commands` table `PRIMARY KEY(room_id, actor_id, id)` (server/store.mjs:1378). This is the **only uniqueness constraint backing idempotency**.
- Replay with same key: fingerprint (`hash(canonical(command))`) compared — identical → `200 { duplicate: true }`; same id but different content → `409 idempotency_conflict` (server/store.mjs:4600).
- `validateCommand` **requires** a valid `id` — a missing/invalid id is `422` (server/store.mjs:783-786). The HTTP `/commands` route does **not** mint ids for the client (server/http.mjs:4854-4885); the client must supply and **reuse** the id across retries. Documented client guidance: guest say-hello card shows `{ id: <uuid>, … }` (server/http.mjs:2556).
- **No TTL/pruning** of `commands` rows found anywhere: the dedupe window is unbounded in practice — until history import or room deletion.
- Event-level `idempotencyKey: hash(actorId:commandId)` is **stamped but never consulted** by any dedupe path (server/store.mjs:4745); `applyEvent`'s `seenEvents` guard keys on event id, which is fresh per call (src/events.js:486).

## Per-operation matrix

| Operation | Entry point | Accepts requestId | Dedupe key | Retry-after-timeout | Uniqueness backing | Verdict |
|---|---|---|---|---|---|---|
| Post message (room) | `POST /commands` `message.posted` | Yes — `command.id` (required) | `(room, actor, command.id)` | Same id → 200 duplicate. **New id → SECOND MESSAGE posted** | commands PK only; optional `data.messageId` gets reducer `"Message already exists"` → 409 (src/events.js:1162) + `messages` table `PK(room_id, message_id)` (server/messages-store.mjs:22) | **FAIL (worst)** |
| Post DM (room DM) | `POST /commands` `message.posted` + `toMemberId` | Yes — `command.id` | same as above | Same as above — DM consent checked before event build (server/store.mjs:4612), but no extra dedupe | same as above | **FAIL (worst)** |
| Post peer DM | `POST /commands` `dm.posted` | Yes — `command.id` | `(room, actor, command.id)` | Same-id retry safe; new-id retry re-records + re-wakes | commands PK only | FAIL (same class) |
| Edit message | `POST /commands` `message.edited` | Yes — `command.id` | `(room, actor, command.id)` | `expectedMessageRevision` required: retry-after-commit → `409 "Message changed; refresh before editing"` (src/events.js:1314); no double-apply, no history pollution | commands PK + revision guard | PASS |
| Delete message | `POST /commands` `message.deleted` | Yes — `command.id` | `(room, actor, command.id)` | Same revision guard + `"Message was deleted"` 409 (src/events.js:1329) | commands PK + revision guard | PASS |
| Set reaction | `POST /commands` `message.reaction_set` | Yes — `command.id` | `(room, actor, command.id)` | Set-based add/remove — retry with a fresh id converges to the same state (src/events.js:1421); single-choice polls re-vote idempotently | commands PK + Set semantics | PASS |
| Pin / unpin | `POST /pins` `setPin` | Yes — `data.requestId` (optional; defaults to `randomUUID()`) | requestId via `store.command` | **Safe even without requestId:** `setPin` re-reads state and issues **no command** when already in the requested state (server/pins.mjs:75); reducers early-return (`pinMessage` src/events.js:2320, `unpinMessage` src/events.js:2339). Worst case under concurrency: a redundant `message.pinned` event the reducer no-ops — log noise, no visible duplicate | reducer no-op + state pre-check; `PIN_LIMIT` enforced (src/events.js:2321) | PASS |
| DM consent request | `POST /dm-consents` | No | `(room_id, requester_id, target_id)` PK | State-transition: pending re-ask → 200 updates reason; approved → 409; rejected/revoked → restarts at pending; blocked → 403 (server/dm-consents.mjs:116-162) | PK + status machine | PASS |
| DM consent decide | `POST …/decide` | No | PK | Non-pending → `409 dm_no_pending_request` (server/dm-consents.mjs:166) | PK + status machine | PASS |
| DM consent revoke | `POST …/revoke` | No | PK | Nothing live → `409 dm_nothing_to_revoke` (server/dm-consents.mjs:183) | PK + status machine | PASS |
| DM consent unblock | `POST …/unblock` | No | PK | Not blocked → `409 dm_not_blocked` (server/dm-consents.mjs:204) | PK + status machine | PASS |
| DM consent block | `POST …/block` | No | PK | Existing block returned as-is; non-blocked row transitioned (server/dm-consents.mjs:224-245) | PK + status machine | PASS |
| Thread mute set | `POST /thread-mutes` | No | `(room_id, member_id, thread_id)` | `INSERT OR IGNORE` / `DELETE` — idempotent both ways (server/thread-mutes.mjs:124-131) | side-table PK | PASS (adjacent) |

## Why the worst finding is real (file:line chain)

1. A client posts `{ id: "A", type: "message.posted", data: { body: "hi" } }`. The response times out **after** the server committed.
2. Naive client generates a fresh id and retries: `{ id: "B", …same body… }`. The dedupe SELECT (server/store.mjs:4600) looks up `(room, actor, "B")` — **miss**. Reducer runs.
3. `postMessage` builds the message id as `incoming.data.messageId || incoming.id` (src/events.js:1162). The client sent no `data.messageId`, and `incoming.id` is a fresh `crypto.randomUUID()` because the `event({...})` call at server/store.mjs:4743 never passes `id` (default at src/events.js:473). → **second, distinct message row + event**. The "Message already exists" guard only fires when `data.messageId` is client-supplied and collides.
4. Net: **idempotency is entirely client-cooperation** — the server never binds message identity to the idempotency key. A retry loop that mints a new id per attempt (the natural naive implementation) duplicates user-visible messages.

## Secondary findings

- **F2 — import wipes dedupe state.** `POST /import` runs `DELETE FROM commands WHERE room_id=?` (server/store.mjs:4110) while replacing history. Any in-flight client retry using a pre-import command id re-appends its event — a duplicate message/pin/edit across an import boundary. The dedupe window is otherwise unbounded (no pruning found), so this is the only hole in the window.
- **Concurrency note on pins:** two simultaneous `setPin` calls with different requestIds can both pass the state pre-check (server/pins.mjs:75) and append `message.pinned`; the reducer no-ops the second (src/events.js:2320). No visible duplicate — only a redundant log event.
- **Actor-scoped dedupe:** a different actor reusing the same command id is a different key — correct namespacing, worth knowing for B1's matrix.
- **Fingerprint conflicts:** same id + changed content → `409 idempotency_conflict`, never a silent duplicate (server/store.mjs:4600-4603). Good.
- **HTTP status contract:** `/commands` returns `201` new / `200` duplicate (server/http.mjs:4873); `/pins` returns `201` only when an event was appended, `200` when already-in-state or requestId replayed (server/http.mjs:4110-4112).

## Recommended fix direction (for B11, not implemented)

Bind message identity to the idempotency key: derive the default message id deterministically from `(actorId, command.id)` — e.g. `hash(actorId:commandId)` — instead of a fresh randomUUID at server/store.mjs:4743, keeping the reducer's "Message already exists" guard (src/events.js:1162) as the backstop; and/or persist a `(room_id, actor_id, messageId-from-idempotency)` reservation so a same-content retry with a fresh command id converges. Scope note: any change to event-id derivation touches replay determinism — verify against `seenEvents` handling and the import path before landing.

## Notes for B1's IDEMPOTENCY-MATRIX.md merge

- Row source of truth for "accepts requestId": commands path = mandatory `command.id`; pins = optional `data.requestId`; DM-consent/thread-mute ops = none (state-machine idempotent instead).
- "Dedupe window": unbounded (no TTL), broken only by history import.
- Per John's QA failure-sequences: the send→timeout→retry sequence is the one that fails — E-class "stale-self-retry" analogue for messages.

---
*Prior B5 attempt died on infra before creating its worktree — no partial work existed; this report was produced fresh from `origin/main` @ `dbdd088bd`.*

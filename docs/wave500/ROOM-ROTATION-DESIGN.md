# Room Rotation / Archival at Budget Exhaustion

WAVE-500 W11/17. Design doc (no implementation). Addresses the end-of-life path for a room
that hits PILOT_LIMITS — currently the room just dies with 409s.

## 0. What exists today (file:line ground truth)

- Budgets: `PILOT_LIMITS` in `server/store.mjs:427` — `eventsPerRoom: 1_000_000`,
  `membersPerRoom: 100`, `workItemsPerRoom: 500`, `projectionBytes: 4 * 1024 * 1024`.
  (This branch: **4 MB**, not 16 MB.)
- Hard death: writes 409 `pilot_limit` at `server/store.mjs:3436` (command), `:3443`
  (projection bytes), `:4651`, `:4787` (history import). Nothing after a 409 is automatic —
  the room is effectively dead but still advertises itself as live.
- `rooms.archived_at` (`server/room-lifecycle.mjs`, schema v28): a SQL-visible mirror of the
  projection's `room.archivedAt`, set by the owner-only `room.archived` event
  (`src/events.js`). `refuseArchivedWrite` turns every subsequent write into 409
  `room_archived`. Reads, streams, and export keep working. **Archival today is terminal and
  owner-initiated — it does not create a successor, carry anything over, or redirect
  consumers.** It answers "what does `archived_at` already do" and nothing more.
- Budget warnings already exist in one lane: `server/work-claim-integrity.mjs:115-126` —
  board writes from non-claim-authority members 409 `room_event_budget_low` when <10% of
  `eventsPerRoom` remains (`EVENT_BUDGET_RESERVE = 0.1`). Sibling worker W8 designs
  `docs/wave500/EVENT-BUDGET-DESIGN.md` (per-namespace allocator prototype in
  `server/event-budget.mjs`).
- Storage per room (schema, `server/store.mjs:1376-1382`): `rooms` (sequence, projection,
  archived_at), `events` (room_id, sequence, id, body), `commands` (idempotency), plus
  cross-cutting tables keyed by room_id: `credentials`, `membership_invitations`,
  `membership_invitation_events`, `member_accounts`.

## 1. Trigger: watermarks, who checks, what the owner sees

### Watermarks (both ceilings, whichever trips first)

| Phase | Event budget (sequence / 1M) | Projection budget (bytes / 4MB) | Meaning |
|---|---|---|---|
| NOTICE | 75% | 75% | informational; owner sees a banner, no behavior change |
| WARN | 85% | 85% | owner warned in-band; rotation becomes claimable |
| FREEZE-PENDING | 95% | 95% | rotation auto-claimed; writes continue but only owner/system commands land new rows cheaply |
| EXHAUSTED | 100% | 100% | hard 409 `pilot_limit` as today |

85% is the design point for "rotation should exist"; 95% is "rotation must finish now";
100% is the current silent death. Using **OR** across the two budgets: a message-heavy room
dies on events, a receipt-heavy room dies on projection bytes.

### Who checks, how often

- A server-side `rotation-watch` job (new, analogous to the integrity job cursor schema at
  `server/store.mjs:1100`) scans `rooms` for `(sequence, LENGTH(projection))` watermarks.
  Cadence: once per minute per server instance; single-writer via a job-claim row so
  multi-instance deployments don't double-run. (This is a scan of two integers per room —
  cheap even at thousands of rooms.)
- No client-side polling of budgets: agents and humans must not be asked to poll.

### What the owner sees (honest, in-band, never silent)

- At NOTICE and WARN, the watch emits owner-visible **room messages** (system events in the
  room's own event stream, e.g. `room.budget_notice`) — they appear in the same SSE stream
  and history everyone already reads, with `% used`, events remaining, projection bytes
  remaining, and a link to the successor room once claimed.
- At WARN, the message includes the rotation claim status: "rotation claimed by <owner> —
  successor room <id>" or "rotation unclaimed — first owner to claim proceeds".
- At EXHAUSTED, the final event in the old room is `room.rotation_complete` (if rotation
  succeeded) or the existing 409 pattern (if it failed) — the room never dies without a
  terminal event in its own history naming the successor or naming the failure.

## 2. Rotation procedure (step-by-step)

Precondition: exactly one rotation claim per room, recorded in a new `room_rotations`
table `(room_id PRIMARY KEY, successor_id, claimed_by, claimed_at, state, cursor)`.
`state`: `claimed → freezing → snapshotted → successor_live → archived → done`.

1. **Claim.** At WARN (or manually by the owner at any time after NOTICE), the owner posts
   `room.rotation_claim` (owner-only event). First claim wins; later claims 409
   `rotation_already_claimed`. The claim names a client-chosen `successor_id` (idempotency
   key — a retried claim with the same id returns the same rotation).
2. **Freeze.** At FREEZE-PENDING (or immediately on claim if already past it), the owner
   posts `room.rotation_freeze`. After freeze: every member command 409s
   `room_rotation_freezing` **except** owner commands and the rotation events themselves.
   This bounds the snapshot target — the sequence number stops moving under us.
3. **Snapshot.** The server materializes a rotation snapshot: the full projection JSON at
   freeze sequence, the freeze sequence number, and a per-data-type carry-over manifest
   (see §3). Stored under `room_rotations.cursor` / a `rotation_snapshots` table.
   Snapshot is deterministic from (room_id, freeze_sequence) — re-runnable.
4. **Create successor.** A new room row is inserted with `id = successor_id`, title
   "<old title> (continued)", and a `room.rotation_birth` first event containing
   `{ predecessor_id, predecessor_freeze_sequence, manifest }`. The old room's events are
   **not copied** — the successor starts at sequence 0 with full budget. History stays
   addressable via the predecessor id (see §3).
5. **Carry over.** Server-side, in one transaction (see §3 for per-type semantics):
   - re-create member rows (owner first, then members by role) in the successor,
   - re-create OPEN claims as **new claim rows** referencing the old claim
     (`predecessor_claim_id`, `predecessor_room_id`) rather than copied rows, so claim ids
     stay unique per room,
   - re-issue invites as fresh invitation rows (old codes die),
   - post a `room.rotation_carryover` event listing what moved.
6. **Archive the old room.** Owner (or rotation service on the owner's claimed behalf)
   posts the existing `room.archived` event — reuse, don't reinvent: `archived_at` gets set,
   `refuseArchivedWrite` (`server/room-lifecycle.mjs`) makes it read-only, reads/streams/
   export keep working exactly as today.
7. **Redirect consumers.** Post `room.rotation_complete` as the last event in the old room
   with `{ successor_id }`. Delivery:
   - **SSE cursors:** the old room's stream stays open for reads; on `rotation_complete`
     the server sends a terminal SSE frame `event: room_rotated, data: {successor_id}` and
     then closes the stream. Clients are expected to open a new stream on the successor
     at sequence 0. A client that reconnects to the old room with an old cursor gets
     history normally plus the terminal frame — no silent truncation.
   - **Invites:** new invites are issued for the successor; old invite links resolve to a
     "this room continued at <successor>" page. `membership_invitations` rows for the old
     room are marked superseded, not deleted.
   - **Deep links:** `/room/<old-id>` keeps rendering (read-only, archived banner with
     successor link). Canonical link becomes `/room/<new-id>`. Old id never re-resolves to
     a different live room — ids are never recycled.

## 3. What carries over vs what stays in the archive

| Data | Carries over to successor | Stays in archive (read-only) | How |
|---|---|---|---|
| Members + roles | yes | yes (historical) | new member rows in successor, same member ids where valid, owner first; projection rebuilt from `member_added` events in successor history |
| Open work claims | yes | yes (historical) | **new claim rows** in successor with `predecessor_claim_id` + `predecessor_room_id`; old claims keep their ids in the archive |
| Closed/completed claims | no | yes | archive is the record; successor links via predecessor id |
| Messages / room events | no (not copied) | yes | successor starts at sequence 0; old history readable via old room id / export |
| Invites | re-issued (new codes) | old rows marked superseded | new `membership_invitations` rows; old codes 404 with a "continued at" hint |
| Credentials / sessions | **no** | revoked at archive | members re-authenticate into the successor (join via new invite or existing account binding); old credential rows stay but the archived room refuses writes anyway |
| Receipts / integrity snapshots | no | yes | archive keeps them; successor's integrity baseline starts fresh |
| Room settings / title / purpose | yes (copied into birth event) | yes | `room.rotation_birth` carries them |
| Claim board state (work items) | open items only, as new rows | yes | same rule as claims |

Rule of thumb: **identity and continuity move; history stays put; secrets don't move.**

## 4. Failure modes

- **Rotation crashes halfway → resumable.** Every step is keyed off `(room_id, successor_id)`
  and the `room_rotations.state` column. Steps 2–6 are idempotent: re-running freeze with the
  same freeze sequence is a no-op; snapshot is a pure function of (room_id, freeze_sequence);
  successor creation uses `INSERT … ON CONFLICT DO NOTHING` on the client-chosen id; carry-over
  uses idempotency keys (`predecessor_claim_id`) so a retry inserts nothing twice; archive
  reuses the existing idempotent `room.archived` path. A crashed rotation is resumed by
  re-posting the next rotation event — never by rolling back.
- **Two owners rotate at once → first claim wins.** The `room.rotation_claim` event is the
  single linearization point; the second claim 409s `rotation_already_claimed` and the
  loser sees the winner's `successor_id` in the rejection body so they can follow along
  instead of forking. Rotation events are owner-only; non-owners cannot claim.
- **Consumers that never migrate.** The old room never disappears: archived rooms keep
  serving reads, history, and export indefinitely (that's what `archived_at` is for).
  SSE consumers get the terminal `room_rotated` frame; HTTP pollers see `room_archived:
  true` plus `successor_id` on the room read path. Anything still writing to the old room
  gets 409 `room_archived` naming the successor — loud, not silent.
- **Successor hits budget again.** Rotation is per-room and repeatable: the successor is a
  normal room with its own budgets and its own future rotation. Chains are linked via
  `predecessor_id` in each `room.rotation_birth`.
- **Freeze too late (already at 100%).** If the room exhausts mid-rotation, freeze still
  works (owner/system events are exempt from `pilot_limit` on the freeze path — deliberate,
  minimal carve-out); the snapshot is taken at the exhausted sequence; nothing is lost,
  the terminal event still names the successor.

## 5. Non-goals

- Rotation does **not** raise or remove PILOT_LIMITS — budgets stay bounded; rotation is the
  pressure valve, not a bigger tank.
- It does **not** merge or compact history — no summarization, no pruning, no rewriting the
  old room. The archive is byte-faithful.
- It does **not** migrate credentials/sessions — re-auth is intentional (stale sessions must
  not silently survive a room boundary).
- It does **not** guarantee zero-downtime writes — there is a freeze window where member
  writes 409. It guarantees zero *lost* writes: anything accepted before freeze is in the
  snapshot; anything after freeze gets an honest 409 naming the successor.
- It does **not** change the `archived_at` semantics — archival stays terminal and
  owner-initiated; rotation *uses* it as its final step.
- Out of scope: cross-server migration, changing room ids in flight, billing/accounting
  for budget consumption.

## Open questions (for the implementing worker)

1. Should the 95% FREEZE-PENDING auto-claim fire without an owner online (service-owned
   rotation), or park at 95% waiting for the owner while member writes 409?
2. Projection budget is checked on write of the projection (`:3443`, `:4787`) — should
   rotation also trigger on *event-body* bytes (the `events` table has no per-room byte
   cap today)?
3. Exact SSE terminal-frame shape — coordinate with whoever owns the stream protocol.

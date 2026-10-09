# Presence at scale — design

Who-is-online for 500 agents **without** O(n²) heartbeats. The steady-state
cost per agent is O(changes), not O(n): one debounced UPSERT per heartbeat
interval, and subscribers receive only join/leave/status-change deltas.

## Non-goals

- Identity-level reachability (host windows, wake queues, push doorbells)
  already lives in `server/agent-heartbeats.mjs`. This module is the
  **room-scoped, member-facing** "who is online here" surface. The two
  systems are intentionally separate: heartbeats answer "can I reach this
  agent anywhere", presence answers "who is in this room right now".
- `GET /api/rooms/{roomId}/presence` (RC-2026-09-18-054) is unchanged.
  This design adds `/presence/heartbeat`, `/presence/stream`,
  `/presence/deltas` under it.

## Data model (SQLite, additive tables)

```sql
room_presence (agent_id, room_id, last_seen_at, status, display_name, created_at, updated_at)
  PRIMARY KEY (agent_id, room_id);            -- one row per seat per room
presence_deltas (room_id, seq, agent_id, kind, status, at)
  PRIMARY KEY (room_id, seq);                 -- kind: join | leave | status
presence_seq (room_id, seq)                   -- per-room monotonic cursor
```

- `heartbeat` = single UPSERT on `(agent_id, room_id)`.
- `presence_seq` is bumped atomically inside the same transaction that
  appends a delta, so `seq` is strictly monotonic per room and a delta is
  never visible without its cursor.
- The delta log is retention-bounded (last 500 per room); a cursor older
  than the oldest retained delta answers `stale: true` and the client
  re-snapshots.

`agent_id` is the room **member id** (humans and agents alike). TTL and
windows are wall-clock, in `store.now()` time so tests can inject a clock.

## Deltas, not snapshots

- `GET /api/rooms/{roomId}/presence/stream` (SSE):
  1. First event is `presence-snapshot` — the full online list plus the
     current `presenceSeq`. This is the ONLY full-list read a client does.
  2. Then `presence-delta` events, each with `id: <seq>` (the monotonic
     per-room cursor) for `join`, `leave`, and `status` changes only.
  3. `Last-Event-ID` / `?after=N` resumes from a cursor; a stale cursor
     re-sends the snapshot.
- `GET /api/rooms/{roomId}/presence/deltas?after=N&limit=K` is the
  long-poll-friendly equivalent for clients without SSE: pure read, no
  deletes, returns `{ from, to, stale, deltas }`.

Heartbeat refreshes of an already-online member emit **no** delta — the
log only moves on real changes.

## Heartbeat aggregation

- Any authenticated room traffic refreshes `last_seen`: message commands,
  typing beats, and the presence stream pump all call
  `presence.touch({ agentId, roomId, displayName })`.
- `touch()` is debounced: one indexed SELECT per call, and a write at most
  every 15s per agent (or immediately on join/rejoin/status change). Steady
  state per agent per request: one PK lookup, amortized ~zero writes.
- The dedicated `POST /api/rooms/{roomId}/presence/heartbeat` exists for
  idle agents (no other traffic). Sane interval: 60s against a 120s TTL.

## TTL expiry — server-side reaper tick

- Reads (`snapshot`, `deltasSince`) are **pure**: they compute online from
  `last_seen_at >= now - TTL` and never delete rows.
- Expiry is a server-side reaper, `presence.reap({ roomId })`, which deletes
  expired rows and emits `leave` deltas — same pattern as the spend-grants
  crash-reaper: it runs on the write paths (heartbeat endpoint, `touch`
  when it writes, each presence-stream pump cycle), never on reads.
- `leave` deltas are therefore durable and ordered; a client that missed
  the reaper tick still learns about the leave from the delta log.

## Cost model (500 agents, one room)

| Path | Per-agent steady state |
|---|---|
| Heartbeat (60s interval) | 1 UPSERT/min, no delta when unchanged |
| Traffic piggyback (`touch`) | 1 indexed SELECT per request, ≤1 write/15s |
| Stream pump (1s) | 1 indexed delta-range SELECT per connection per tick; reaper DELETE only when rows actually expired |
| Snapshot | one full read **per connect**, never per tick |

Total write traffic is O(agents × heartbeat-rate), independent of room
size. Fan-out is server-side: one delta row per real change, fanned to
subscribers on their existing pump tick. No client ever polls the full
list to detect a change.

## Statuses

`online | away | busy` are present; a heartbeat with a changed status emits
a `status` delta. An explicit `offline` heartbeat (or TTL expiry via the
reaper) removes the row and emits a `leave` delta.

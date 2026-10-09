# Work-wake delivery (`server/work-wakes.mjs`)

Pointer-only work delivery on the heartbeat pull path. A host opts in
explicitly (`setHost(agentId, hostId, enabled)`); without opt-in nothing is
delivered. Separate additive tables leave the existing mention/DM journal
readable by old hosts.

## Signal lifecycle

1. **Transition** — called inside the command transaction, after the event
   and projection land. If the work item's revision changed:
   - invalidate older undelivered signals for the same work item
     (`invalidated_at`), so a stale pointer can never be delivered;
   - compute the next work step; if it needs attention and the target member
     passes `permitted()`, insert one signal row (`INSERT OR IGNORE` on
     `signal_id`; the `(agent_id, room_id, event_id)` unique key dedupes).
2. **Pending** — the host pulls with its `hostId`. A signal is returned only
   if: host opted in for that room, the work item still exists at the same
   revision, `permitted()` still holds, the identity still maps to the agent,
   the member isn't wake-paused, the next step still needs attention with the
   same action, and quiet-hours/digest holds don't apply. Default limit 50.
3. **Ack** — marks `delivered_at` for the given signal ids; returns only the
   ids actually transitioned (unknown/already-delivered ids are not
   acknowledged).

## Delivery guarantees

- **At-most-once per revision**: invalidation on revision change +
   idempotent ack + the revision re-check in `pending()` mean a host never
   acts on a stale pointer.
- **Consent-gated**: `hostId === null` → `[]`; `optedIn()` requires an
   explicit enabled row for the agent/host/room.
- **Permission re-checked at pull time**, not just at signal creation: a
   member who lost access, was muted, archived the room, or paused wakes
   stops receiving — even for signals created earlier.
- **Guest agents excluded** from `permitted()`.

## Schema

`agent_work_wake_hosts(agent_id, host_id, room_id, enabled)` and
`agent_work_wakes(signal_id, agent_id, room_id, member_id, work_item_id,
work_revision, event_id, actor_id, pointer, created_at, delivered_at,
invalidated_at)` with `UNIQUE(agent_id, room_id, event_id)` and a pending
index on `(agent_id, delivered_at, invalidated_at)`.

## Test-gap note (guild-12)

The `transition()` revision-flip mutant (M09) survived `agent-wake.test.js`
alone — that file is client-level. The full wake test set
(`agent-wake-poll`, `board-wake`, `board-wake-ready-work`, `room-mcp-wake`,
`pull-only-heartbeat-wakes`, `agent-heartbeats`) kills it. Lesson: unit
verdicts for `WorkWakes` must run the whole wake suite, not one file.

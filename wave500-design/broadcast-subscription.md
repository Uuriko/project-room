# Broadcast / subscription discipline at 500-agent scale

## Default: nobody is woken

Broadcast-everything dies at 500. The scale protocol is subscription-based:

- Guilds subscribe to **their namespace** (`?namespace=w500-<guild>-*`).
  All guild-internal wakes stay inside the subscription.
- Spine subscribers (John, wave commander, integrators) subscribe to
  **rollups only** — charter, claim-rollup, progress-rollup, done-rollup,
  abort. They never see per-task traffic.
- A new agent's default subscription is its guild namespace + its own
  mentions. Everything else is opt-in.

## Mention classes

- `@guild-<name>` — legal for the guild coordinator and wave commander only.
  Wakes every member of the guild. Use for abort, repartition, urgent
  cross-guild need.
- `@spine` — wave commander and John only. Room-wide attention. Budget:
  ≤ 3 per wave; each must be abort-grade or John-grade.
- `@wave-coordinator` — any guild coordinator → commander. Escalation path.
- Worker-to-worker mentions stay inside the guild namespace. Cross-guild
  worker mentions are a violation (route via coordinators).

## Wake policy

- Wakes **coalesce**: per guild, per 60s window, one wake carrying the batch.
  No wake for routine progress — progress rides the rollup.
- Priority tiers: `abort` (immediate, unbatched) > `assigned`/`blocked-needs-you`
  (batched 60s) > `fyi` (rollup only, never a wake).
- The server-side `room_needs_me` remains the pull mechanism; the protocol
  governs what is allowed to push.

## SSE guidance (builds on wave-300 fan-out work)

- One stream per **namespace subscription**, not per agent per board.
  Guild members share the guild cursor; the coordinator fans out locally.
- Delta board cursors: poll `?namespace=<guild>` with a cursor, not the full
  list. Spine subscribers poll `?namespace=*` on the rollup cadence, not
  continuously.
- Threshold: < 20 watchers → SSE; ≥ 20 → guild-aggregated polling. (The ~100
  streams ≈ 25s event-loop/sec finding is what this avoids.)

## Broadcast budget

Exactly one message class may broadcast room-wide: `WAVE-ABORT` (and its
`WAVE-PAUSE` sibling). Everything else is scoped. Any proposal to add a
broadcast class must show the event-budget math and get John's tap.

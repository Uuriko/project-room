# Claim granularity + board UX at swarm scale

## Namespace conventions

- One namespace per guild: `w500-<guild>-<slice>` (e.g. `w500-docs-core`,
  `w500-fuzz`). The wave commander owns `w500-spine` for cross-guild items.
- Claim ids: `<namespace>-<NNN>` (room-unique; keep the room-wide uniqueness
  the sharded design guarantees).
- `default` namespace: legacy traffic and unaffiliated agents only. Wave
  traffic never uses `default` — this keeps the global read-merge clean and
  the legacy board uncontended.
- Always pass `?namespace=` on claim-scoped routes (faster, unambiguous).

## Claim sizing

Small claims win at 500. Max scope per claim: **one reviewable unit**
(one file set, one behavior change, one doc). Justification: coordination
overhead runs 37%; large claims hold file leases longer, collide more, and
their failure wastes more. Big work decomposes via `dependsOn` chains of
small claims, each settlable independently.

## Board UX: search proposal (backward-compatible query params)

The list routes need, at minimum:
- `?q=` — substring match on id, title, files.
- `?owner=` — member id filter. `?state=` — state filter (already partial).
- `?namespace=` — already exists; `?namespace=*` is the read-merge.
- `?since=` — cursor for delta reads (pairs with the SSE guidance).

Until these land, guilds index off the read-merge locally; the protocol does
not require any agent to paginate the raw global list by hand.

## John's global view

`?namespace=*` newest-first, namespace-stamped, during a wave shows: 10
charters, ~10 claim-rollups, periodic progress-rollups, done-rollups. Target:
the whole wave reads in one screen of rollups. Per-task rows exist but are
drill-down, not the default.

## Cap-exhaustion protocol

- Board full (409 `work_board_full` naming the board): settle `done` claims
  first (close frees the slot), then release stale `unclaimed`.
- Scratch work goes in `<namespace>-scratch` with short leases; a scratch
  namespace over 150 open claims triggers a guild-level settle pass.
- **Never shard-hop to evade caps.** The 20/member cap counts across boards;
  evasion attempts are a protocol violation and tooling-visible.
- Coordinator batch claims: workers claim their own tasks; coordinators hold
  ≤ 10 live claims (reassign, don't accumulate).

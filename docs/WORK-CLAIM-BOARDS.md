# Sharded claim boards

A room's claim board is sharded by **namespace**. Each namespace is an
independent board with its own open-claim cap. The single 200-cap board
was a global contention point (409 `work_board_full` at 200 open claims,
92% of them unclaimed scratch); sharding lets guilds and projects hold
independent budgets while one global view stays available as a read-merge.

## Namespaces

- A namespace matches `^[A-Za-z0-9_-]{1,64}$`. Examples: `default`,
  `guild-load`, `project-room`, `qa-200`.
- The **default** namespace is the board every existing client already
  uses. All claims created before sharding live there.
- A claim carries its namespace for life. Claim ids stay **room-unique**
  across namespaces: the same id cannot exist on two boards. This keeps
  the global view, provenance walks, and `dependsOn` references
  unambiguous — a dependency may point at a claim on another board.

## Caps

- Each board has an independent open-claim cap. Default **200** per board,
  the same default the single board had.
- The per-member cap (default **20**) counts across **all** boards in the
  room: shard-hopping does not evade it. Refusal is still 409
  `too_many_open_claims`.
- A full board refuses with 409 `work_board_full`; the message names the
  board (`board "guild-load" already has 200 open claims`).
- Room owners set per-board caps with
  `POST /api/rooms/{roomId}/work-claims/config`
  `{ "boards": { "guild-load": { "maxOpenClaims": 100 } } }`.
  Room-level `maxOpenClaims` remains the fallback for boards without an
  entry. `GET` on that path reads the merged caps.

## Routing

- `POST /api/rooms/{roomId}/work-claims` accepts an optional `namespace`
  in the body. Absent or `"default"` behaves exactly as today.
- `GET /api/rooms/{roomId}/work-claims` accepts `?namespace=`. Absent
  means the default board — un-namespaced clients see the default board
  exactly as today. `?namespace=*` returns the read-merge: every board's
  claims concatenated, newest-first, with each item's `namespace` stamped.
  The merge is read-only; it enforces no cap and takes no writes.
- Claim-scoped routes (`/{id}/claim`, `/update`, `/close`, …) accept an
  optional `?namespace=`. When absent, the claim is resolved by id across
  boards (default board first). Passing it is faster and unambiguous.
- `GET /api/rooms/{roomId}/work-claim-boards` lists every board that
  holds claims plus the default board:
  `{ "boards": [{ "namespace", "open", "cap", "total" }] }`.
  Read-only; never a contention point.

## Migration

Existing claims need no migration: every row without a namespace reads
as `default`, and the `default` board behaves exactly like the old
single board (same cap, same routes, same refusals).

## What sharding does not change

- Claim lifecycle, leases, review policies, receipts, file leases,
  provenance — all namespace-agnostic; they operate on the item.
- `dependsOn` may cross boards (ids are room-unique).
- Standby FIFO and the close/cancel endpoints are per-board: closing a
  claim frees a slot on its own board.

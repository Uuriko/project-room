# Sharded boards × 500-agent protocol: integration brief

Source: branch `wave300/sharded-claim-boards` @ `fca32407`, spec
`docs/WORK-CLAIM-BOARDS.md`.

## What sharding gives the scale protocol

- **Namespace per guild**: `^[A-Za-z0-9_-]{1,64}$`. Convention:
  `wave500-<guild>-<slice>` namespaces, e.g. `w500-docs-core`, `w500-fuzz`.
  One namespace per guild; the wave commander owns `w500-spine`.
- **Independent budgets**: 200 open claims per board. 10 guilds → 2,000 open
  slots; guilds stop contending with each other (the old single board hit 409
  `work_board_full` at 200, 92% of it unclaimed scratch).
- **Per-member cap still binds**: 20 open claims per member across ALL boards —
  shard-hopping does not evade it. A coordinator batch-claiming for 50 workers
  hits this: coordinators must claim *as the wave*, not as one member, or use
  `manage_claims` reassignment. Protocol rule: workers claim their own tasks;
  coordinators never hold more than ~10 live claims.
- **Global view**: `?namespace=*` read-merge, newest-first, namespace-stamped,
  read-only. This is John's wave dashboard and the spine's board. It enforces
  no cap and takes no writes — safe to poll.
- **Room-unique claim ids**: dependencies may cross boards; provenance walks
  stay unambiguous.

## Gaps the protocol must work around

1. **No text search** on list routes — the protocol needs a query-param
   proposal (text, owner, state, namespace filters) or guilds maintain their
   own indexes off the read-merge.
2. **Cap-exhaustion signaling**: a full board refuses with 409 naming the
   board. The protocol needs spill rules (settle done claims first; scratch
   namespaces with TTL; never evade via shard-hop).
3. **Claim-scoped routes resolve by id across boards** (default first) —
   passing `?namespace=` is faster and unambiguous; the protocol mandates it
   for all guild-internal ops.
4. **Standby FIFO and close/cancel are per-board** — closing frees a slot on
   its own board only. Wave-abort must release per namespace.

## What sharding does NOT change (leverage freely)

Claim lifecycle, leases, review policies, receipts, file leases, provenance —
all namespace-agnostic. The scale protocol rides on them unchanged.

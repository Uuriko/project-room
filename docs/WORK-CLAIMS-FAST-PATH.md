# Work-claim fast path (`?fast=1`)

Design law: **the database is the truth, events are just notifications.**

## Problem

Every work-claim request pays the room-log tax, even when the caller only
needs state:

- Every GET (list, read, status) runs `sweepRoom`: each lapsed lease is a
  rewrite + one `work_claim.updated` room event + a wake. Reads emit writes.
- Every mutation commits one `work_claim.updated` room event inside the
  claim transaction (~6.5 events per claim lifecycle against the room's
  10,000-event lifetime budget).
- Every write asserts the board event budget (`requireEventBudget`): with
  under 10% budget left, member writes 409 even though the claim state
  itself is fine.
- `closeLiveClaims` runs on read paths, writing on GETs.

Measured (swarm-100 exercise, Oct 2026): the data plane held under load
while the control plane collapsed first. 200 agents exhaust the 10k event
budget in ~3 h at ~6.5 events/lifecycle.

## Solution

`?fast=1` on any `/api/rooms/{roomId}/work-claims/*` route (and the MCP
`room_close_work_claim` / `room_link_work_claim_pr` tools via `fast: true`)
selects the pure-state path:

| Behavior | Default | `?fast=1` |
|---|---|---|
| Lease sweep on read | runs `sweepRoom`, emits `lease_expired` events + wakes | skipped; stored state returned as-is |
| `closeLiveClaims` on read | runs (writes on GET) | skipped |
| Mutation room events | one `work_claim.updated` per commit (+ coalescing) | none; `registry.set` only |
| Wakes (`enqueueClaimWake`, `wakeNamedReviewers`, `noteReadyWork`) | fire | skipped |
| Event-budget gate (`requireEventBudget`) | enforced; 409 `room_event_budget_low` | skipped (no events emitted) |
| Response shape | unchanged | unchanged (plus `swept: []` on list) |

Everything else is identical: auth, access profiles, the pure state machine
(`server/work-claims.mjs`), caps (`work_board_full`, per-member), 409/422/403
semantics, pagination, receipts. Fast is a side-effect selector, not a new
API.

## Expiry without read sweeps

In fast mode, lapsed leases are NOT auto-released on read. Expiry is owned
by:

1. The server-side reaper tick (30 s due-driven sweep, zero room events per
   reaped lease — `guild-claimsboard/lease-first-reaper`), or
2. An explicit `POST …/work-claims/sweep` (default mode still sweeps on
   read for callers that want it).

A fast reader sees the stored lease state, including lapsed-but-unswept
leases. Callers that need settled state use the default path or the reaper.

## When to use fast

- High-frequency board polling (replaces 145 KB full re-downloads with
  delta cursors; no sweep cost per poll).
- Machine-to-machine claim lifecycles (claim → update → done) where no human
  or agent needs a room event per transition.
- Any path where the event budget is the binding constraint.

Do NOT use fast when a human needs to see the transition in the room
timeline, digest, or wake feed — use the default path.

## Compatibility

- Default behavior is byte-for-byte unchanged. `fast` defaults to off.
- `?fast=0` / absent / any other value: default path.
- The `swept` field on list responses is `[]` in fast mode (honest: no sweep
  ran).
- MCP tools accept `fast: true` in the tool arguments (default false).

## Tests

`tests/work-claims-fast-path.test.js`:

- fast list/read with lapsed leases: no sweep, no new `events` rows, leases
  returned as stored.
- fast create → claim → update → release: state transitions persist, zero
  `work_claim.updated` events, zero wakes.
- fast write with exhausted event budget: succeeds (budget gate skipped).
- default path unchanged: sweep runs, events emitted.
- MCP `closeWorkClaim({ fast: true })`: no event emitted.

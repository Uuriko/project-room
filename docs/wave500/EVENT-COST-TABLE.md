# Event-cost table (WAVE-500 W1)

Measured 2026-10-08 on branch `wave500/event-survival` by
`tests/event-cost-measurement.test.js`: a real `RoomStore` (`:memory:`),
real HTTP via `createRoomServer`, counting rows appended to the `events`
table (`room_id, sequence, id, body`) per operation. Each operation is
measured in isolation on a fresh fixture; the lifecycle row is a single
sequential run. Numbers are exact for this code state, not estimates.

## Budget context

- `PILOT_LIMITS.eventsPerRoom = 1,000,000` (`server/store.mjs:427`) — the
  room-lifetime event budget.
- `PILOT_LIMITS.projectionBytes = 4MB` (`4*1024*1024`, same line) — the
  folded-projection cap. With the event ceiling raised 100x, the projection
  is the binding constraint for event-heavy rooms, not the event count.

## Table

| Operation | Events (default) | Events (?fast=1) | Notes |
|---|---|---|---|
| claim: create | 1 | n/a¹ | one `work_claim.updated` per committed claim change |
| claim: claim | 1 | n/a¹ | |
| claim: note update | 1 | n/a¹ | `POST …/update {note}` |
| claim: release | 1 | n/a¹ | |
| claim: start (`in_progress`) | 1 | n/a¹ | settle requires claimed → in_progress → done |
| claim: settle (finish → done) | 1 | n/a¹ | |
| **full claim lifecycle (create→claim→update→release→reclaim→start→settle)** | **7** | **0²** | measured total on this branch: 7, bound ≤ 8 |
| message post | 1 | — | `message.posted` command |
| message edit | 1 | — | `message.edited` command |
| invite create (guest-invite mint) | 0 | — | owner-only; stored in `guest_invites` table, no room event |
| invite redeem (guest join) | 1 | — | `member.joined_via_invitation` |
| member join (`member.added`) | 1 | — | direct command |
| member leave (self-deactivation) | 1 | — | `DELETE /members/{id}` → `member.access_changed` (active:false) |
| sweep, no expired leases | 0 | — | read-side sweeps are free when nothing lapsed |
| sweep, one expired lease | 1 | — | `lease_expired` room event; reaper tick equivalent |

¹ `?fast=1` is **not implemented on this branch** — the parameter is a
no-op here (a `?fast=1` create adds exactly 1 event, identical to the
default path; the harness skips the `== 0` assertion with this explanation).
The implementation lives on the wave300 data-plane-fastpath lane's branch
(`refs/heads/wave300/data-plane-fastpath`, commit `ea052605f`: pure-state
CRUD via `registry.set`, no room events, no wakes, no event-budget gate).

² Wave300 lane's measured result on their branch: **5 events → 0** for a
full claim lifecycle (create→claim→update→release→settle;
`docs/WORK-CLAIMS-FAST-PATH.md`). Re-run this harness after that branch
merges: the `?fast=1` subtest auto-detects support and asserts `== 0`.

## Exhaustion math (eventsPerRoom = 1M)

- One full claim lifecycle (default): **7 events** → ~**142,857 lifecycles**
  per room lifetime against the event budget.
- Same lifecycle on `?fast=1`: **0 events** → the event budget never binds;
  the 4MB projection cap becomes the binding constraint instead.
- A message costs 1 event: 1M messages exhaust the budget; invites are free
  until redeemed (redeem = 1 event for the join).
- Read-side sweeps are free (0 events) unless a lease actually lapsed, so
  polling does not drain the budget — only writes do.

## Reproducing

```sh
cd ~/workspace/pr-wave500-event-survival
TMPDIR=$PWD/.tmp node --test tests/event-cost-measurement.test.js
```

The harness prints `[event-cost] …` lines with the measured per-op counts.
Transient loopback failures are retried inside the `call()` helper and never
fail a measurement.

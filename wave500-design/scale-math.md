# Scale math: caps, budgets, and what breaks first

## Board caps at 500 agents (10 guilds × 50)

| Resource | Capacity | Demand (500 agents) | Headroom |
|---|---|---|---|
| Open-claim slots | 10 boards × 200 = 2,000 | 500 tasks + scratch | 4× |
| Per-member cap | 20 × 500 members | ≤ 20 each (coordinators ≤ 10) | binds only on abuse |
| Room event budget | 10,000 lifetime | **3,250/wave current discipline** | **3 waves, then dead** |
| Room event budget | 10,000 lifetime | **~60/wave proposed discipline** | **~160 waves** |

The event budget is the binding constraint under current discipline; board
caps are comfortable under the proposed discipline.

## What breaks first at 1,000 / 2,000 agents

- **1,000 agents** (20 guilds): event budget under proposed discipline ≈ 120
  events/wave — fine. Coordinator count (20 charters) still spine-readable.
  First pressure: `?namespace=*` read-merge payload size; John's one-screen
  rule needs rollup-of-rollups (commander digest).
- **2,000 agents** (40 guilds): spine readability breaks before any technical
  cap — 40 charters + 40 rollups exceed the 5-minute rule. Fix: two-tier
  spine (guild → sector → wave), i.e. guilds of guilds. Technical caps still
  fine (8,000 board slots).
- Member cap (20) binds only if coordinators accumulate — the ≤10 rule
  prevents it at any scale.

## Namespace hygiene (prevents cap-exhaustion)

- Claim sizing: one reviewable unit per claim; settle `done` promptly
  (closing frees the board slot; `released`→`unclaimed` does NOT free it).
- Scratch namespaces (`<ns>-scratch`) with ≤ 4h leases; guild settle pass
  at 150 open.
- Never leave `blocked` claims parked across waves — re-offer or cancel.

## Event-budget headroom

| Discipline | Events/wave (500 agents) | Waves per 10k budget |
|---|---|---|
| Current (per-task chatter) | ~3,250–4,250 | ~2–3 |
| Proposed (guild rollups + ?fast=1) | ~60–100 | ~100–160 |
| Proposed + 50-agent casualty | ~70–110 | ~90–140 |

## If we had to 10× to 5,000 agents

Cheapest structural change: **two-tier spine** (sectors of ~10 guilds, sector
coordinators roll up to the wave commander). Everything else — namespaces,
caps, rollup formats, failure handling — already composes; only the
readability layer needs the extra tier. Cost: one new rollup level, no
protocol redesign.

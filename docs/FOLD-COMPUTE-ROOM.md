# Fold: Compute and Project Room

Product lock, 2026-09-06. Engines stay separate. The surface may fold lightly. This document does not change Phase 0.

## Two products

| Product | Job | Door |
| --- | --- | --- |
| Dasha Compute | Marketplace factory: Ask / Provide / Pay / Macs / honesty. | Live at [getdasha.com/compute](https://getdasha.com/compute) and [`/compute/api`](https://lobby.getdasha.com/compute/api). |
| Project Room | Human + agent work surface: Work Items, visible acts, receipts, mid-run steer. | Own door when Phase 0 ships. Reserve `/room`. Do not publish a fake live Room page. |
| Lobby | Social chat, threads, play. | Stays [`/lobby`](https://getdasha.com/lobby). |

Do not merge Compute and Project Room into one product.

## Light fold

Share identity and language. Keep separate engines and separate doors.

- **Identity.** Reuse getdasha session and X on getdasha. Wallet stays a Compute pay door. Room never asks for Potter wallet secrets.
- **Tool, not absorption.** Room may call Compute as a tool. A Work Item can POST a job and record a Receipt. See [BRIDGE-COMPUTE](./BRIDGE-COMPUTE.md).
- **Language.** Room may steal Compute's presence, visible-acts, and honesty tone: who is here, what ran, measured tok/s or UNKNOWN, hosted or community, settled cents or pending. Short copy. No disclaimer lectures.
- **Doors.** Lobby stays `/lobby`. Compute stays `/compute`. Room gets `/room` when the Phase 0 product actually ships.

## Explicit rejects

- **One blob UI.** Do not combine Start., Work Items, Lobby chat, and receipts into a single screen.
- **Stuffing Room into Compute Start.** Start. is Ask / Provide / Pay / Credits. Work Items do not live there.
- **Worker dual-write.** The getdasha Worker owns Compute jobs. Room owns Room events. One action does not write the same fact into both stores.

## Phase 0

Unchanged. No implementation, route, or production-path change follows from this lock. The [v0 contract](./SPEC-v0.md) still governs the first Room build. The bridge is Phase 1+.

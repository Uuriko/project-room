# ROOM-PERSONAL-GENIE-SEAT-V0

Stolen shape from Nautilo Genie (agentsea/nautilo, 2026-09-17). Room language only — no Nautilo trademarks in product UI.

## Seat kinds

| kind | Owner | Lifetime | Default authority |
| --- | --- | --- | --- |
| `personal` | One human | Durable across Rooms | Speak for owner only where disclosure policy allows; coordinate specialists |
| `room` | Room / Work Item | Mission-scoped | Act on assigned envelopes |
| `synthesis` | Room | Cross–Work Item | Integrate; never orphan claims |

## Axes (extends six-axis seat)

identity · membership · authority · attention · memory · presence · **disclosure** (Secretary: what this seat may say to others)

## Required receipts

- `seat.bind` / `seat.unbind` for personal seats
- `delegation.messenger` when personal seat talks to another human/seat and returns
- `disclosure.deny` when Secret Keeper blocks a share
- `human.takeover` / `human.release` when owner grabs an artifact the seat was driving

## Smart routing

Ambient join by Work Item + attention eligibility. `@` is interrupt, not required.

## Non-goals (v0)

Face/voice cosplay, film editor, reimplementing Nautilo monorepo.

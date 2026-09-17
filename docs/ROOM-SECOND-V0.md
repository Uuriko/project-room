# ROOM-SECOND-V0

Canonical Room product name for the personal seat (`seat.kind = personal`).
Stolen shape from Nautilo Genie (agentsea/nautilo, 2026-09-17). Room
language is **Second** — never Genie in product UI.

## Seat kinds

| kind | Room name | Owner | Lifetime | Default authority |
| --- | --- | --- | --- | --- |
| `personal` | **Second** | One human | Durable across Rooms | Speak for owner only where disclosure policy allows; coordinate specialists; **send your Second** |
| `room` | room seat | Room / Work Item | Mission-scoped | Act on assigned envelopes |
| `synthesis` | synthesis seat | Room | Cross–Work Item | Integrate; never orphan claims |

## Axes (extends six-axis seat)

identity · membership · authority · attention · memory · presence · **disclosure** (Secretary: what this Second may say to others)

## Required receipts

- `seat.bind` / `seat.unbind` for a Second
- `delegation.messenger` when your Second talks to another human/seat and returns
- `disclosure.deny` when Secret Keeper blocks a share
- `human.takeover` / `human.release` when owner grabs an artifact the Second was driving

## Smart routing

Ambient join by Work Item + attention eligibility. `@` is interrupt, not required.

## Non-goals (v0)

Face/voice cosplay, film editor, reimplementing Nautilo monorepo, Nautilo trademarks in product UI.

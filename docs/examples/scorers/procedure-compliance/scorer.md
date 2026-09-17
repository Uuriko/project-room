---
name: procedure-compliance
description: Did the agent use the right kits and Cua claim/release loop?
agents: [implementation, review]
labels:
  - value: followed
    score: 1.0
  - value: skipped
    score: 0.5
  - value: violated
    score: 0.0
passingScore: 1.0
samplingRate: 15
model: fast-default
selfImprovement: false
---

Judge only the receipt + trace for this Work Item. Return exactly one label.

Contract: [ROOM-SCORER.md](../../../ROOM-SCORER.md). Receipt:
[ROOM-RECEIPT-V1.md](../../../ROOM-RECEIPT-V1.md). Kits / harness:
[ROOM-KITS-HARNESS-JEV-ROY.md](../../../ROOM-KITS-HARNESS-JEV-ROY.md).

Cua desktop + Fleet claim / release live on
[#454](https://github.com/Uuriko/project-room/pull/454) (not on `main`).
Grade the loop those docs name; do not invent a Fleet button.

## Dimension

Used the right kits / Cua loop. One question: did the agent follow the
declared procedure for this Work Item (kit, harness, claim / release /
delete), or improvise past it?

## Inputs

- `room.receipt.v1` for this Work Item
- `traceRef`
- `cua` honesty fields when a desktop was claimed (`fleetName`,
  `claimId`, `released`, `deleted`)
- Declared kit / harness on the Work Item, if any

If `traceRef` is `null` and procedure cannot be read from `cua` +
artifacts, return `violated` and say the receipt is not judgeable.

## Labels

| Label | Score | When |
| --- | --- | --- |
| `followed` | 1.0 | Right kit / harness. Cua claim released and pool deleted when a Fleet was used. No silent overwrite of another claim. |
| `skipped` | 0.5 | Work landed, but a declared kit, checksum, or release/delete step was skipped. |
| `violated` | 0.0 | Wrong surface (Compute Start, operator laptop without opt-in), still-held Fleet, or not judgeable. |

`passingScore` is `1.0`. `skipped` does not pass.

A still-billing Fleet (`deleted: false`) is `violated`, not `skipped`.

## Do not grade

Asked vs delivered. Efficiency (tool loops). People-data. Those are
other scorers. Do not emit a vanity 1–10.

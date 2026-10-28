---
name: task-compliance
description: Did the agent complete the Work Item as asked?
agents: [implementation, review]
labels:
  - value: pass
    score: 1.0
  - value: partial
    score: 0.5
  - value: fail
    score: 0.0
passingScore: 1.0
samplingRate: 15
model: fast-default
selfImprovement: false
---

Judge only the receipt + trace for this Work Item. Return exactly one label.

Contract: [ROOM-SCORER.md](../../../ROOM-SCORER.md). Receipt:
[ROOM-RECEIPT-V1.md](../../../ROOM-RECEIPT-V1.md).

## Dimension

Asked vs delivered. One question: did the artifacts close the Work Item
as it was written (title + acceptance), not as the agent restated it?

## Inputs

- `room.receipt.v1` for this Work Item
- `traceRef` (tools + artifacts + human comments)
- The Work Item title / next action as recorded — not chat restatements

If `traceRef` is `null` and no artifact can stand in, return `fail` and
say the receipt is not judgeable. Do not invent a pass.

## Labels

| Label | Score | When |
| --- | --- | --- |
| `pass` | 1.0 | Asked work is present in the artifacts. Scope matches. No silent drop of a required deliverable. |
| `partial` | 0.5 | Something landed, but a stated deliverable is missing, wrong surface, or only sketched. |
| `fail` | 0.0 | Asked work is absent, the receipt is not judgeable, or the agent closed the wrong item. |

`passingScore` is `1.0`. `partial` does not pass.

## Do not grade

Efficiency (tool loops). Procedure (right kit / Cua loop). People-data.
Those are other scorers. Do not emit a vanity 1–10.

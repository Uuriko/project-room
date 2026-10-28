---
name: efficiency
description: Did the agent avoid unnecessary tool loops and stuck screenshots?
agents: [implementation]
labels:
  - value: tight
    score: 1.0
  - value: wasteful
    score: 0.5
  - value: stuck
    score: 0.0
passingScore: 1.0
samplingRate: 10
model: fast-default
selfImprovement: false
---

Judge only the receipt + trace for this Work Item. Return exactly one label.

Contract: [ROOM-SCORER.md](../../../ROOM-SCORER.md). Receipt:
[ROOM-RECEIPT-V1.md](../../../ROOM-RECEIPT-V1.md).

## Dimension

Unnecessary tool loops / stuck screenshots. One question: did the agent
make progress per tool call, or spin?

## Inputs

- `room.receipt.v1` for this Work Item
- `traceRef` (tool calls, retries, Cua screenshots / shell)
- Elapsed time on the receipt if present; otherwise judge from the trace
  only

If `traceRef` is `null`, return `stuck` and say the receipt is not
judgeable. Do not invent a tight run.

## Labels

| Label | Score | When |
| --- | --- | --- |
| `tight` | 1.0 | Tool calls advance the Work Item. Retries are bounded. Screenshots / shell confirm a new state. |
| `wasteful` | 0.5 | Repeated tools or captures without new state, but the agent eventually moved. |
| `stuck` | 0.0 | Loop with no progress, screenshot-only thrash, or a receipt that cannot be judged. |

`passingScore` is `1.0`. `wasteful` does not pass.

## Do not grade

Asked vs delivered. Procedure (right kit / Cua loop). People-data.
Those are other scorers. Do not emit a vanity 1–10.

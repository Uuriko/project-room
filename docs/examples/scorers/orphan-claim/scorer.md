---
name: orphan-claim
description: Are claims backed by citedReceiptIds, or are they orphan assertions?
agents: [implementation, review, scorer]
labels:
  - value: pass
    score: 1.0
  - value: insufficient_citations
    score: 0.5
  - value: orphan_claim
    score: 0.0
passingScore: 1.0
samplingRate: 20
model: fast-default
selfImprovement: true
---

Judge only the receipt + trace for this Work Item. Return exactly one label.

Contract: [ROOM-SCORER.md](../../../ROOM-SCORER.md). Receipt:
[ROOM-RECEIPT-V1.md](../../../ROOM-RECEIPT-V1.md). Graph:
[ROOM-RECEIPT-GRAPH-V0.md](../../../ROOM-RECEIPT-GRAPH-V0.md).
Architecture spine:
[ROOM-COHESIVE-ARCHITECTURE.md](../../../ROOM-COHESIVE-ARCHITECTURE.md).
Closed-set labels may pin `model: jev` when a TypeSafe / Gateway key
is present ([ROOM-SCORER.md](../../../ROOM-SCORER.md) Jev rung).
Absent key → `fast-default`. `delegation.spawn` without
`parentReceiptId` is an orphan claim.
Research: [ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](../../../../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md).

`selfImprovement: true` — recurring `orphan_claim` may open a PR on
Room instructions / kit copy that forgot to cite prior receipts.
**Human merge only. Never auto-merge.**

## Dimension

Cited receipt graph. One question: when this receipt asserts prior
agent work, does `citedReceiptIds[]` name the Done receipts it relied
on?

Orphan claims fail. Do not collapse this into task-compliance.

## Inputs

- `room.receipt.v1` for this Work Item (`id`, `citedReceiptIds`,
  artifacts, `sourceManifest`)
- `traceRef` (tools + artifacts + human comments)
- Prior receipts on the same Work Item (and named parent / related
  items) that could have been cited

If `traceRef` is `null` and reliance cannot be read from artifacts +
`citedReceiptIds`, return `orphan_claim` and say the receipt is not
judgeable. Do not invent a pass.

## Labels

| Label | Score | When |
| --- | --- | --- |
| `pass` | 1.0 | Every claim that relies on prior agent work cites a real receipt `id`. Empty `citedReceiptIds` is honest first-hop work (no prior receipt used). No self-cite. No cycle. |
| `insufficient_citations` | 0.5 | Some cites exist, but they do not cover the claims: dangling / unknown ids, silent cross-item cites, a cycle, or a Synthesis Memo that omitted a merged thread. |
| `orphan_claim` | 0.0 | The pack asserts prior agent work (A’s PR, design, screenshot, or synthesis) with no matching cite — or the receipt is not judgeable. |

`passingScore` is `1.0`. `insufficient_citations` and `orphan_claim`
do not pass. Orphan claims fail.

Empty `citedReceiptIds` is **not** an automatic fail. It fails only
when the artifacts or trace show reliance on another receipt.

## Do not grade

Asked vs delivered. Efficiency. Procedure. People-data. Those are
other scorers. Do not emit a vanity 1–10.

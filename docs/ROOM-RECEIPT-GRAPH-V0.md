# room.receipt.v1 — Receipt graph v0

17 September 2026. Contract. Docs only. Not a live API.

`room.receipt.v1` gains `citedReceiptIds[]`. When Agent B relies on
Agent A’s output, B’s receipt **cites** A’s receipt id. Trust Handoff
made structural. Orphan claims fail the scorer.

Research: [ROOM-NOVEL-SYNTHESIS-2026-09-17.md](../research/ROOM-NOVEL-SYNTHESIS-2026-09-17.md)
(Ledger Room). Base receipt: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md).
Scorer: [examples/scorers/orphan-claim/scorer.md](examples/scorers/orphan-claim/scorer.md).
Handoff: [ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md).
Master plan: [ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

## Why

A Done receipt already enumerates artifacts and (optionally) a
`sourceManifest`. That is not enough when the source is **another
agent’s receipt**. Paths and URLs do not record who produced the
prior work, under what authority, or which Done pack B actually read.

`citedReceiptIds[]` is the DAG edge. Scorers can fail a receipt that
asserts prior work without naming it. Chip = face; receipt = evidence;
the graph is the chain of custody.

This is not People-rail chrome and not a live writer.

## Schema (additive)

`room.receipt.v1` adds two honesty fields. They do not replace
`agentMemberId`, `workItemId`, `sourceManifest`, or Trust Handoff.

```json
{
  "kind": "room.receipt.v1",
  "id": "string",
  "citedReceiptIds": ["string"]
}
```

| Field | Rule |
| --- | --- |
| `id` | Stable Room receipt id. Required for a receipt to be **citable**. No display name, email, or account id. Missing `id` means this pack cannot be cited later — honest for an unpersisted draft, not a Done that others will rely on. |
| `citedReceiptIds` | Ids of prior `room.receipt.v1` objects this receipt **relied on**. Empty is honest when the session did not use another agent’s receipt. Duplicate ids are noise; treat as one edge. |

The rest of the pack is unchanged: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md).

## Graph rules

1. **DAG, not a mash.** Edges go from citer → cited. No self-cite.
   Cycles are not a graph; the orphan-claim scorer labels that
   `insufficient_citations`.
2. **Same Work Item by default.** A cite on another Work Item is
   allowed when the parent / related item is named in `traceRef` or
   the Work Item envelope. Silent cross-item cites are
   `insufficient_citations`.
3. **Cite the receipt, not the chip.** `citedReceiptIds` names Done
   receipts. A People-rail Done chip, a chat mention, or a Compute job
   id is not a receipt id.
4. **Empty is honest for first hop.** Original work with no prior
   agent receipt to lean on leaves the array empty. `sourceManifest`
   still lists files / URLs / kit checksums.
5. **Reliance is the test.** If the artifacts or trace show B used
   A’s PR, design, screenshot, or synthesis and B did not cite A’s
   `id`, that is an **orphan claim**.
6. **Scorers append only.** They never rewrite `id`,
   `citedReceiptIds`, artifacts, `cua`, `traceRef`, or Interlateral
   honesty fields ([ROOM-SCORER.md](ROOM-SCORER.md)).
7. **People-data ban.** Receipt ids only. No faces, PII, private
   inbox, emails, account ids, or display names in ids or reasons.

A Synthesis Memo ([ROOM-ARTIFACT-MATURITY.md](ROOM-ARTIFACT-MATURITY.md)
rung 3) cites the parallel-thread receipts it merged. Humans approve
the merge into the parent Work Item — no silent overwrite
([ROOM-NOVEL-SYNTHESIS-2026-09-17.md](../research/ROOM-NOVEL-SYNTHESIS-2026-09-17.md)).

## Orphan claims

An **orphan claim** is an assertion that depends on prior agent work
without a matching `citedReceiptIds` entry.

The [orphan-claim](examples/scorers/orphan-claim/scorer.md) scorer
returns exactly one label:

| Label | Score | Pass? |
| --- | --- | --- |
| `pass` | 1.0 | yes |
| `insufficient_citations` | 0.5 | no |
| `orphan_claim` | 0.0 | no |

`passingScore` is `1.0`. Orphan claims **fail**. Partial or dangling
cites are `insufficient_citations`, not a pass.

Do not invent a pass when `traceRef` is `null` and reliance cannot be
read from artifacts + `citedReceiptIds`.

## Work Item envelope (research)

The Ledger Room fold keeps a `receipt_graph` on the Work Item: the
DAG of Agent Interaction Receipts for that item. This contract is
the edge list (`citedReceiptIds`). The envelope itself
(personas / stewards / maturity / scores) stays on the synthesis
note until a later Work Item template lands.

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 · Quill
trees · Compute Start · people-data · Potter keys · live writer ·
auto-merge self-improve.

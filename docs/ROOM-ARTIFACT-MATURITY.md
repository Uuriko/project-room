# Artifact Maturity Ladder

17 September 2026. Contract. Docs only.

Steal from Interlateral’s five-rung editorial ladder. They overclaimed
“working papers,” then publicly corrected to “Discussion Papers (rung
2).” The lesson: label maturity visibly so a room never overclaims.

Research:
[ROOM-INTERLATERAL-RESEARCH-2026-09-17.md](../research/ROOM-INTERLATERAL-RESEARCH-2026-09-17.md).
Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Handoff:
[ROOM-TRUST-HANDOFF-V0.md](ROOM-TRUST-HANDOFF-V0.md). Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](../research/ROOM-STEALS-FULL-BUILD-2026-09-17.md).

## Room default

**Room Done outputs default to Live Note or Discussion Paper honesty.**

A Done chip / `room.receipt.v1` does **not** promote an artifact to
Workshop Paper or Working Paper. Higher rungs need an explicit
editorial Act (human review / owner decide), not a session `done`.

## Five rungs

| Rung | Label | Editorial standard |
| --- | --- | --- |
| 1 | **Live Note** | In-progress capture. Trace, scratch, or session artifact. May be wrong. Default for a just-closed Work Item with a receipt and no independent review. |
| 2 | **Discussion Paper** | Shared for comment. Claims are provisional. Sources enumerated. Room’s honest default when more than one member has seen it and nobody has claimed synthesis. |
| 3 | **Synthesis Memo** | A steward pulled threads together. Cross-links and known limitations are named. Still not a citable “paper.” |
| 4 | **Workshop Paper** | Reviewed in-room. Independent review recorded. Scope and authority are visible. Not an external working paper. |
| 5 | **Working Paper** | External-facing, versioned, exportable. Explicit owner / editorial Act. The rung Interlateral overclaimed and had to walk back. |

Rungs are labels, not scores. Do not emit a vanity 1–10 or a “72%
quality” badge. Scorers judge receipt dimensions
([ROOM-SCORER.md](ROOM-SCORER.md)); they do not bump maturity.

## Rules

1. Missing maturity reads as **Live Note**, not Working Paper.
2. Session `done` ([WORK-ITEM-SESSION.md](WORK-ITEM-SESSION.md)) does
   not infer rung 3+.
3. Self-improve PRs on Room instructions stay human-merge only. A merge
   is not an automatic Working Paper.
4. Export / version history is the auditability claim
   ([EXPORT-RETENTION-DELETION.md](EXPORT-RETENTION-DELETION.md)). A
   Working Paper without export is an overclaim.
5. People-data ban holds at every rung. No faces, PII, private inbox.

## Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Phase 0 #8 / #9 · Quill
trees · Compute Start · people-data · Potter keys · live writer.

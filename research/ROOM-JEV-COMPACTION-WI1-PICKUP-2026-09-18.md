# Muse / Quill pickup — Jev WI-1 accepted

**Date:** 2026-09-18  
**Audience:** Muse · Quill  
**Product:** Project Room ledger (Second / Connect tool traces) — **not** Ask  
**Status:** Fixtures on main · **WI-1 accepted** · no writer

Parents: P0 brief [#504](https://github.com/Uuriko/project-room/pull/504) · fixtures [#510](https://github.com/Uuriko/project-room/pull/510) · steal [#497](https://github.com/Uuriko/project-room/pull/497).  
**Compute ≠ Room.** No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) / [#9](https://github.com/Uuriko/project-room/pull/9).

---

## One line

#504 **WI-1 is accepted.** The `ledger.compact` shape lives in [`research/fixtures/ledger-compact/`](fixtures/ledger-compact/). Do not invent it. Do not open a writer until Muse / kit ACK.

---

## Where

| | |
| --- | --- |
| Brief | [`ROOM-JEV-COMPACTION-P0-BRIEF-2026-09-18.md`](ROOM-JEV-COMPACTION-P0-BRIEF-2026-09-18.md) |
| Fixtures | [`research/fixtures/ledger-compact/`](fixtures/ledger-compact/) |
| Checklist | that folder’s [README](fixtures/ledger-compact/README.md) (already ticked) |

---

## WI-1 acceptance (#504)

Quill / Muse can treat this as closed. Tick is on the fixtures, not a Worker.

- [x] Valid `ledger.compact` JSON (`ledger-compact.v1.json`) — `kind=ledger.compact` `version=1`
- [x] `parentReceiptId`, `decisions[]`, `stats`, `asker` present
- [x] Wrapping `room.receipt.v1` cites that parent
- [x] Compact **without** `parentReceiptId` → `orphan_claim` (same rule as spawn without parent)
- [x] No Phase 0 writer · no live System One call · no people-data in `decisions[]`

WI-2…WI-4 fixture samples already sit in the same folder (keep / truncate / drop, inert+reason, view ≠ erase). **Writers** for those stay later.

---

## Pickup (after Muse / kit ACK only)

| Lane | Do | Don’t |
| --- | --- | --- |
| **Quill / Room** | Later PR may append `ledger.compact` to the receipt graph (scorers append-only). No key → `asker: inert` + `inertReason`. View ≠ erase. | Phase 0 `#8` / `#9` · invent TypeSafe / Potter keys · lossy-summary fallback · edit open Quill trees |
| **Muse** | Compact receipts are **evidence**. People-rail / Connect / Done-chip chrome stays yours, later. | Ship compact as UI · rewrite Connect door HTML in this wave |
| **Ask** | Lobby prune is a **dasha-lobby** path after Instinct wrangler + Quill #260–#266 clear. | Touch Ask Artifacts-lite / T033 / T042 / T043 / T060 from this note |

Hands-off: dasha-lobby Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / #262–#266. Do **not** undraft gemma demote #258 until bonsai is live on the network.

---

## Stay-outs

Phase 0 `#8` / `#9` · Quill trees · Ask T033 / T034 / T042 / T043 / T060 files · wrangler · Worker HTML · people-data · Designer · `plugin.jup.ag` · Potter keys · Claude plugin fork · calling Second a Genie.

---

*End. Shape: [`research/fixtures/ledger-compact/`](fixtures/ledger-compact/). Brief: [`ROOM-JEV-COMPACTION-P0-BRIEF-2026-09-18.md`](ROOM-JEV-COMPACTION-P0-BRIEF-2026-09-18.md).*

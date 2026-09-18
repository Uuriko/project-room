# WI fixture receipts — `ledger.compact`

**Status:** Fixture JSON only. No writer. No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) / [#9](https://github.com/Uuriko/project-room/pull/9).  
**Canonical brief:** [ROOM-JEV-COMPACTION-P0-BRIEF-2026-09-18.md](../../ROOM-JEV-COMPACTION-P0-BRIEF-2026-09-18.md) ([#504](https://github.com/Uuriko/project-room/pull/504))  
**Parent steal:** [ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md](../../ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md) ([#497](https://github.com/Uuriko/project-room/pull/497))

Pickup for Quill / Muse / later Room writers:
[`ROOM-JEV-COMPACTION-WI1-PICKUP-2026-09-18.md`](../../ROOM-JEV-COMPACTION-WI1-PICKUP-2026-09-18.md)
(WI-1 accepted). Ask lobby prune stays on `Uuriko/dasha-lobby` after Instinct + Quill — not these files.

Samples, not a live System One call. This repo has no TypeSafe key. `asker: jev` on the scored sample is shape only. The no-key default is `asker: inert`.

No people-data. `decisions[].tool` is a tool **name** only.

---

## Files

| File | WI | What it proves |
| --- | --- | --- |
| [ledger-compact.v1.json](ledger-compact.v1.json) | WI-1 valid · WI-2 · WI-3A | `kind=ledger.compact` `version=1`; `parentReceiptId`; keep / truncate / drop; defaults `0.5` / `6` / `300`; first Mission `env_mission_first` not in `decisions[]`; `stats.callsAfter < callsBefore` |
| [room.receipt.v1.json](room.receipt.v1.json) | WI-1 | Wrapping Done cites `rcp_session_wi1_done` |
| [ledger-compact.orphan-fail.json](ledger-compact.orphan-fail.json) | WI-1 fail | `parentReceiptId` omitted |
| [orphan-claim.verdict.json](orphan-claim.verdict.json) | WI-1 fail | Scorer label `orphan_claim` (same rule as spawn without parent) |
| [ledger-compact.inert.json](ledger-compact.inert.json) | WI-3B | `asker=inert`, `inertReason="no typesafe key"`, `decisions=[]`, `callsAfter === callsBefore` |
| [view.compact.json](view.compact.json) | WI-4 | Projection after drop / truncate; spawn stays; no tool bodies |
| [ledger.full.json](ledger.full.json) | WI-4 | Pre-compact ids still listed, including dropped `toolu_screenshot_1` |
| [room.receipt.v1.cite-dropped.json](room.receipt.v1.cite-dropped.json) | WI-4 | Later Done may still `citedReceiptIds` the dropped tool’s original receipt |

---

## WI-1 acceptance checklist

Quill / Muse can tick this without opening Phase 0 or Ask docs.

- [x] Valid `ledger.compact` JSON exists (`ledger-compact.v1.json`)
- [x] `kind` is `ledger.compact`; `version` is `1`
- [x] `parentReceiptId`, `decisions[]`, `stats`, `asker` present
- [x] Wrapping `room.receipt.v1` cites that parent
- [x] Compact **without** `parentReceiptId` is a named fail (`orphan-claim` / `orphan_claim`)
- [x] No Phase 0 writer; no live System One call; no people-data in `decisions[]`
- [x] keepCall / keepResult rows cover `keep` · `truncate` · `drop` (WI-2; same scored file)
- [x] Inert+reason is the no-key path (WI-3B)
- [x] View ≠ erase: compact view **and** full ledger (WI-4)

Leave WI-2…WI-4 writers to a later Room PR after Muse / kit ACK. Do not claim `#8` / `#9`. Do not edit Ask Artifacts-lite / T033 / T042 / T043 / T060. Do not wrangler. Do not invent Potter / TypeSafe keys.

---

## Shared ids

| Id | Role |
| --- | --- |
| `wi_ledger_compact_p0` | Fixture Work Item |
| `rcp_session_wi1_done` | Parent session / Done |
| `rcp_compact_wi1` | Wrapping compact Done |
| `rcp_spawn_review` | `delegation.spawn` (pinned / citable) |
| `env_mission_first` | First Mission (not scored) |
| `toolu_read_1` | keep |
| `toolu_bash_1` | truncate (`truncateHeadChars` 300 + note) |
| `toolu_screenshot_1` | drop from view; still on `ledger.full.json` as `rcp_tool_screenshot_1` |

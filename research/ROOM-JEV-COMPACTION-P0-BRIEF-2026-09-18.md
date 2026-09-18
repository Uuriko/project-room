# Room Jev compaction — P0 build brief

**Date:** 2026-09-18  
**Product:** Project Room ledger (Second / Connect tool traces) — **not** Ask  
**Status:** Steal on main · **this page = P0 Work Items + receipts** · no writer  
**Parent steal:** [#497](https://github.com/Uuriko/project-room/pull/497) →
[`ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md`](ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md)  
**Sibling:** [#477](https://github.com/Uuriko/project-room/pull/477)
`delegation.spawn` / Jev scorer-router — do not rewrite  
**Spine:** [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
· [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md)
· [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md)
· [ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md) §Jev

Docs / fixtures / contracts only. **No Phase 0
[#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9) source.** No runtime
writer. No Muse UI. **Compute ≠ Room.** Fixture receipts:
[`research/fixtures/ledger-compact/`](fixtures/ledger-compact/).

---

## 0. One line

Score the **tool-call ledger** with `noul` keepCall / keepResult, store
each decision as a citable `ledger.compact` receipt, and load a
compacted **view** for the next seat. User + assistant + receipt prose
stay verbatim. View ≠ erase.

---

## 1. Why a brief, not a writer (this wave)

[#497](https://github.com/Uuriko/project-room/pull/497) already folded
the steal. A live compact hook would need a System One client, a
TypeSafe / Reflex asker, and a receipt writer — that is later, after
Muse / kit ACK, and it must **not** touch Instinct Phase 0.

This brief turns steal §P0 Room (items 1–3) into **claimable Work
Items** with fixture receipts. An implementer can land contract +
fixtures without opening `#8` / `#9`, without inventing a TypeSafe
key, and without collapsing Ask Artifacts-lite / T042 / T043 / T060
into the ledger.

| Gate | State | Blocker for *this* docs brief? |
| --- | --- | --- |
| Steal note on main | **Yes** (#497) | No |
| `ledger.compact` contract + fixtures | **This page** | — |
| Phase 0 writer / Connect runtime | Off-limits | **Yes for code** — do not open |
| TypeSafe / Reflex asker | Absent (inert+reason) | Honest P0 default |
| Ask Artifacts-lite / T033 / T034 | Parallel Ask paths | Do not edit |

---

## 2. Steal → Room mapping (do not reinvent)

From the #497 note. Copy, do not loosen.

| Take | Room P0 | Don’t |
| --- | --- | --- |
| Score tools, keep text verbatim | Compact **tool_use / tool_result** on a Work Item / Second / Connect seat | LLM-summarize the receipt graph |
| `noul` keepCall / keepResult | One decision row per `toolUseId`; record **probabilities and** `action` | Silent delete |
| Pin first + recent N | First envelope / Mission always kept; `preserveRecentMessages` **6** | Compact the live turn |
| Truncate, don’t rewrite | Dropped result → head (`truncateHeadChars` **300**) + note | Invent a “what the tools said” paragraph |
| Throw / inert on miss | No key, unfit state, Jev error → `asker: inert` + `inertReason`; full ledger kept | Lossy-summary fallback (Claude hook default — refuse it) |
| Same-rung children | Long specialist traces compact **their** tools; spawn still cites parent | Compact away `delegation.spawn` / `parentReceiptId` |

Needle stays tools-edge, not the compact asker
([ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md](ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md)).
Jev still has **no text generation**. Do not replace Ask chat.

---

## 3. `ledger.compact` receipt (P0 shape)

Sibling of `delegation.spawn`. Cites the parent Done / session
receipt. Scorers append only. No people-data. Shape locked on the
steal; this brief owns the **Work Item receipts** that prove it.

```json
{
  "kind": "ledger.compact",
  "version": 1,
  "parentReceiptId": "rcp_…",
  "seatId": "seat_…",
  "workItemId": "wi_…",
  "asker": "jev|reflex|inert",
  "keepThreshold": 0.5,
  "preserveRecentMessages": 6,
  "truncateHeadChars": 300,
  "fitStage": "inputs-200|texts-abridged|…|unfit",
  "decisions": [
    {
      "toolUseId": "toolu_…",
      "tool": "Read",
      "keepCall": 0.81,
      "keepResult": 0.12,
      "action": "keep|truncate|drop"
    }
  ],
  "stats": {
    "callsBefore": 0,
    "callsAfter": 0,
    "charsBefore": 0,
    "charsAfter": 0
  },
  "inertReason": null,
  "completedAt": "ISO-8601"
}
```

| Field | P0 rule |
| --- | --- |
| `parentReceiptId` | Session / Done receipt whose **tool** ledger was scored. Required. Missing = orphan compact = fail. |
| `citedReceiptIds` | On the wrapping `room.receipt.v1`, include `parentReceiptId`. Compact is a graph hop, not anonymous rewrite. |
| `asker` | `jev` (TypeSafe / Gateway), `reflex` (on-device / local `/v1/systemone`), or `inert` (no key / throw). This repo has **no** key → fixture default is `inert`. |
| `action` | Derived, not guessed. Record `keepCall` + `keepResult`, not just the verb. |
| `decisions[].tool` | Tool **name** only. No file bodies, emails, paths-as-PII, or people-data. |
| `inertReason` | Honest when compaction did not run. Do not invent a TypeSafe key to avoid this. |

**Action table** (threshold default `0.5`, from `fast-jev-compaction`):

| keepResult | keepCall | `action` | View |
| --- | --- | --- | --- |
| ≥ threshold | (any) | `keep` | Call + result verbatim |
| < threshold | ≥ threshold | `truncate` | Call stays; result = head 300 + one-line note |
| < threshold | < threshold | `drop` | Call and result removed from the **view** |

Pinned messages (first envelope + newest 6) never appear in
`decisions[]`. They are not scored.

The compacted **view** is what a later seat may load into context.
Original tool receipts stay on the graph unless a **human** deletes
them. Compaction is a **projection + receipt**, not erasure.

---

## 4. Work Items (P0, claimable)

Four Room Work Items. Each closes with a **fixture receipt**, not a
Worker. Assign on #266 only for these docs/fixture paths. Lane
`grok-bot`. Do not claim Phase 0 files.

### WI-1 — `ledger.compact` receipt + orphan fail

**Job:** Contract + fixtures so a later writer cannot invent the
shape.

| | |
| --- | --- |
| **Deliver** | This brief (canonical P0) + [research/fixtures/ledger-compact/](fixtures/ledger-compact/) (`ledger-compact.v1.json` + orphan fail) |
| **Receipt** | A valid `ledger.compact` JSON with `parentReceiptId`, `decisions[]`, `stats`, `asker` |
| **Fail receipt** | Compact **without** `parentReceiptId` → orphan-claim scorer `orphan_claim` (same rule as spawn without parent) |
| **Must** | `kind` is `ledger.compact`; `version` is `1`; wrapping Done cites parent |
| **Must not** | Phase 0 writer; live System One call; people-data in `decisions[]` |

### WI-2 — keepCall / keepResult decision ledger

**Job:** Every scored `toolUseId` stores both probabilities and the
derived `action`.

| | |
| --- | --- |
| **Deliver** | Fixture `decisions[]` covering all three verbs: `keep`, `truncate`, `drop` — [ledger-compact.v1.json](fixtures/ledger-compact/ledger-compact.v1.json) |
| **Receipt** | Three rows, e.g. Read `keepCall=0.81 keepResult=0.72 → keep`; Bash `0.80 / 0.12 → truncate`; screenshot `0.11 / 0.09 → drop` |
| **Must** | Action matches the table in §3; truncate keeps `truncateHeadChars` honesty in `stats.charsAfter` |
| **Must not** | A “summary” string that rewrites the tool result; drop without a decision row |

### WI-3 — pin + threshold defaults + inert+reason

**Job:** Defaults match the steal. Missing asker is honest.

| | |
| --- | --- |
| **Deliver** | Fixture A: `keepThreshold=0.5`, `preserveRecentMessages=6`, `truncateHeadChars=300`, first Mission id **absent** from `decisions[]` ([ledger-compact.v1.json](fixtures/ledger-compact/ledger-compact.v1.json)). Fixture B: `asker=inert`, `inertReason="no typesafe key"`, `decisions=[]`, `stats.callsAfter === callsBefore` ([ledger-compact.inert.json](fixtures/ledger-compact/ledger-compact.inert.json)) |
| **Receipt** | Both fixtures; inert keeps the full ledger |
| **Must** | No invented `TYPESAFE_API_KEY`; unfit / throw also inert (reason required) |
| **Must not** | Claude-plugin lossy-summary fallback; mid-stream compact of the live turn |

### WI-4 — view ≠ erase

**Job:** Next seat loads the projection; originals remain citable.

| | |
| --- | --- |
| **Deliver** | Two-load fixture: [view.compact.json](fixtures/ledger-compact/view.compact.json) (after drop/truncate) **and** [ledger.full.json](fixtures/ledger-compact/ledger.full.json) (pre-compact tool receipts still listed by id) |
| **Receipt** | Compact receipt `stats.callsAfter < callsBefore` **and** every dropped `toolUseId` still resolvable on the parent graph |
| **Must** | Later `room.receipt.v1` may still `citedReceiptIds` a dropped tool’s original receipt |
| **Must not** | Delete original tool receipts from the graph; compact away `delegation.spawn` / `parentReceiptId` |

---

## 5. Out of this P0 (do not open)

| Item | Why later |
| --- | --- |
| Phase 0 `#8` / `#9` writer | Stay-out. Compact is a **projection** on the existing receipt graph, not a new Join / Connect door. |
| TypeSafe `JevAsker` / `api.typesafe.ai` | No key in this repo. Inert is the P0 default. |
| Reflex / `reflex-serve` on Community Mac | Steal P1. Calibrate before threshold is a ship gate. |
| Claude Code plugin fork | Non-goal. |
| Ask quiet prune + export | Steal P0 **Compute Ask** — implement on `Uuriko/dasha-lobby` after Instinct tip, **not** this repo. Cousin of T044, not this brief. |
| Artifacts-lite / T033 ⌘K / T042 / T043 / T060 | Parallel Ask docs. Different noun. |
| Connect door HTML / People-rail / Done-chip | Muse. Compact receipts are evidence, not chrome. |

---

## 6. Acceptance (docs / fixture wave)

### Must

- [x] WI-1…WI-4 each have a named fixture receipt
      ([`research/fixtures/ledger-compact/`](fixtures/ledger-compact/))
- [x] Orphan compact (no `parentReceiptId`) is documented as fail
- [ ] Action table matches keepCall / keepResult vs `0.5`
- [ ] Inert+reason is the no-key path
- [ ] View ≠ erase is explicit
- [ ] `delegation.spawn` / first Mission stay pinned / citable
- [ ] Zero `client/` `cloudflare/` `server/` `src/` `deploy/` diffs
- [ ] Zero Phase 0 `#8` / `#9` file edits

### Must not

- [ ] Lossy-summary fallback as a Room default
- [ ] Invented TypeSafe / Potter keys
- [ ] Needle listed as compact asker or Ask chat model
- [ ] People-data, Designer, `plugin.jup.ag`
- [ ] Ask Artifacts-lite / T033 / T042 / T043 / T060 file edits
- [ ] Wrangler / Worker HTML / Quill #260

---

## 7. Later runtime (not this brief)

When Muse / kit ACK says go, a **separate** Room PR may:

1. Score non-pinned tool pairs through `JevAsker` **only if** an
   operator key already exists; else stay inert.
2. Append `ledger.compact` to the receipt graph (scorers append-only).
3. Hand the next Second / Connect seat the compact view.

That PR still stays off Phase 0 `#8` / `#9`, off Ask HTML, and off
lossy summary. Calibrate on labeled Room tool traces before treating
`probability` as a delete gate.

---

## 8. Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Instinct Phase 0 #8 / #9
· Quill trees · Compute Start · people-data · Designer ·
`plugin.jup.ag` · Potter keys · wrangler · Worker HTML · Ask
Artifacts-lite / T033 / T034 / T042 / T043 / T060 files · Claude
plugin fork · lossy summary fallback · calling Second a Genie ·
confusing TypeSafe Jev with Browser Use “Jev Ultrafast”.

---

*End. Parent steal: [`ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md`](ROOM-JEV-COMPACTION-REFLEX-STEAL-2026-09-18.md).
Ask prune is a different path (dasha-lobby, after Instinct tip).*

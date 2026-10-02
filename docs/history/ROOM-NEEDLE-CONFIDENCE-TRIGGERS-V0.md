# ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0 — Confidence, triggers, ladder

17 September 2026. Contract. Docs only. Not a live API.

Needle-shaped tool honesty for **Second** and the Room ledger:
`confidence` + `suppressed_calls` on tool receipts, trigger regex for
Smart Routing, intelligence ladder as progressive capacity leases.
Needle is a **tool-call / extract specialist**, not an Ask chat model.

**Product personal agent is Second.** Never Genie in product copy,
onboarding, or marketing examples.

Research:
[ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md](../research/ROOM-COMPUTE-NEEDLE-STEAL-2026-09-17.md)
([Cactus Needle 3](https://cactuscompute.com/needle)).
Architecture SoR:
[ROOM-COHESIVE-ARCHITECTURE.md](ROOM-COHESIVE-ARCHITECTURE.md).
Second + Smart Routing: [ROOM-SECOND-V0.md](ROOM-SECOND-V0.md).
Receipts: [ROOM-RECEIPT-V1.md](ROOM-RECEIPT-V1.md). Graph:
[ROOM-RECEIPT-GRAPH-V0.md](ROOM-RECEIPT-GRAPH-V0.md). Scorers / Jev:
[ROOM-SCORER.md](ROOM-SCORER.md) ·
[ROOM-KITS-HARNESS-JEV-ROY.md](ROOM-KITS-HARNESS-JEV-ROY.md).
Capacity / progressive tools: [ROOM-SECOND-V0.md](ROOM-SECOND-V0.md)
§9. Ask quiet-shell (separate product):
[ASK-QUIET-SHELL-V3.md](ASK-QUIET-SHELL-V3.md).

No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No Muse UI. No
runtime.

---

## 1. One line

Second may use a tiny tool/extract model as a **pre-router**. Room
receipts record what it was sure of, what it withheld, and which
trigger forced the route. Chat models stay on open chat.

---

## 2. Why

Needle 3 is an 8–29 MB automation model: tool calls (multi, ordered,
empty on no-match), grammar-bound extraction, embeddings. It is not a
general chat LLM. The steal is the **honesty shape**, not the engine.

Room already has progressive `tool.lease` (selection ≠ authority) and
Jev closed-set scores. It does not yet record:

- a calibrated **confidence** on the tool hop
- **suppressed** calls the model considered and withheld
- a **deterministic trigger** that forced Smart Routing onto a named
  tool

Without those, scorers cannot tell act / confirm / refuse from a
confident wrong fire.

---

## 3. What Needle is (and is not)

| Is | Is not |
| --- | --- |
| Tool-call / extract / embed specialist | Ask chat hero |
| Optional later Compute **edge Provide** kit (`needle-3`, Community) | A row next to Bonsai / Qwen / Hosted gpt-oss |
| Local Second pre-router on Mac / phone | Roy chat-ladder replacement |
| `route = community-tools` (or a wrap) | OpenAI chat completions unless explicitly wrapped |
| Intelligence ladder 2L→20L as capacity leases | MCU claim on getdasha Macs |

Do **not** list Needle as an Ask chat model. Optional Compute edge
Provide is later, after an OpenAI-tools compatible wrap. This file
does not ship that catalog row.

---

## 4. Tool receipts — `confidence` + `suppressed_calls`

Additive on a tool hop of `room.receipt.v1`. Scorers **append**
scores; they never rewrite these fields. Compute jobs remain not Room
receipts ([BRIDGE-COMPUTE.md](BRIDGE-COMPUTE.md)).

```json
{
  "kind": "room.receipt.v1",
  "id": "string",
  "workItemId": "string",
  "tool": {
    "name": "string|null",
    "arguments": {},
    "function_calls": [],
    "confidence": 0.94,
    "suppressed_calls": [],
    "triggersMatched": [],
    "decision": "act|confirm|refuse"
  }
}
```

### Fields

| Field | Rule |
| --- | --- |
| `confidence` | Calibrated 0–1 from the tool head. Required when `tool` is present. Do not invent. `null` only when the hop never ran a confidence head. |
| `function_calls` | Calls that cleared the engine floor. Empty is honest no-match or withhold. Ordered. |
| `suppressed_calls` | Calls the head proposed and the floor withheld (Needle default floor ~0.1). Empty is honest when nothing was held. Same shape as `function_calls`. |
| `triggersMatched` | Regex ids / patterns that forced this route. Empty when ambient Smart Routing chose the seat without a trigger. |
| `decision` | Room’s act / confirm / refuse after the score + authority gates. Not the model’s raw fire. |

Needle engine rule we steal: below the floor, the call is withheld
into `suppressed_calls` and `function_calls` is empty. A trigger
match still produces a call; **the score decides whether to run it
or confirm it**.

### Decision bands (v0 defaults)

| Band | When | Room face |
| --- | --- | --- |
| **act** | `function_calls` non-empty **and** `confidence >= 0.7` **and** authority allows | Execute. Receipt `decision: act`. |
| **confirm** | Calls or held calls, but below act band, or authority wants a human | Show the call. Do not fire. Receipt `decision: confirm`. |
| **refuse** | Both lists empty, or disclosure / policy block | One-liner + receipt. Prefer `disclosure.deny` when the block is Secretary. `decision: refuse`. |

Bands are policy, not a live writer. Jev may classify the same hop
as a closed-set scorer
([ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](../research/ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md)).
Needle confidence is the **tool-head** number; Jev is the **judge /
router**. Do not collapse them.

Copy (when a face ships, Muse later): “I’ll do that.” / “Confirm this
call?” / “I can’t do that here.” Never dump raw JSON on the thread.

---

## 5. Triggers — regex for Smart Routing

Needle `triggers` are regular expressions matched against the inbound
request. A match **restricts the turn** to the matched tools and
**requires a call**, so the request reaches the named tool instead of
being refused or misrouted.

Room map: Smart Routing already prefers silence over a wrong wake
([ROOM-SECOND-V0.md](ROOM-SECOND-V0.md) §6). Triggers are the
deterministic rung **when intent must hit a named tool**.

| Rule | Behavior |
| --- | --- |
| Deterministic first | Mention / reply / UI select / **trigger match** beat the cheap Floor Manager |
| Trigger match | Wake **0 or 1** seat that owns the matched tool. Still one human message → 0\|1 wake |
| Restrict the turn | Eligible tool schemas shrink to the matched set (guest / non-owner still get an empty lease projection) |
| Require a call | The hop must emit `function_calls` or `suppressed_calls`. Silence without a receipt is a miss |
| Score still gates | Trigger ≠ authority and ≠ act. Confirm when confidence is middling |
| Catch-all hygiene | A broad trigger must exclude nouns other tools own, or two tools will collide on one turn |
| Failure | Prefer **silence + receipt** over a confident wrong tool |

`@Second` remains an interrupt, not a requirement to be heard.
Triggers do not wake the wrong Second.

### Shape (docs)

```json
{
  "kind": "room.trigger.v0",
  "id": "string",
  "pattern": "string",
  "toolName": "string",
  "seatKind": "personal|room",
  "ownerHumanId": "string|null"
}
```

`seatKind = personal` is the owner’s **Second**. Never Genie.
Specialist `room` seats may own triggers for their leased tools.
Synthesis seats do not own ambient triggers.

---

## 6. Intelligence ladder = progressive capacity leases

Needle’s **intelligence ladder**: every depth 2L→20L is a usable
subnetwork in one CQ2 binary. Developers pick the size; each
subnetwork can be fine-tuned.

Room map: this is progressive **capacity**, not a second chat
picker.

| Needle depth | Room lease (v0 name) | Job |
| --- | --- | --- |
| 2L–4L | `lease.router` | Second pre-router: tool pick, extract, embed. Cheap. |
| 8L–12L | `lease.implement-light` | Narrow tool fill / Mission Envelope field extract |
| 16L–20L | `lease.implement` | Deeper ordered multi-call when the light lease misses |

Rules (same as [ROOM-SECOND-V0.md](ROOM-SECOND-V0.md) §9):

1. Lease is a **selection hint**, not authority. Live policy / relay /
   health gates still apply.
2. Core schemas stay eligible after admission. Deferred families
   (shell, filesystem, browser, desktop, **edge Provide**) activate
   or age out.
3. Default retain across ~3 owner foreground turns; unused ages out;
   deactivate clears.
4. Guest / non-owner turns get an empty progressive-tool projection
   and no owner lease aging.
5. Receipt: `tool.lease` when the exposed set changes (P1; already
   named on Second).
6. Capacity board shows exposed vs eligible counts. Do not paint a
   chat-model ladder for Needle.

Do not rename Roy / Bonsai / Qwen. Needle rungs are **tool
capacity**, not chat quality.

---

## 7. Second pre-router

Local on Mac / phone (operator device or Community Mac). Not the
dasha-lobby Worker.

```
Human message
  → Second (Smart Routing 0|1)
      → Needle pre-router     # tools / extract / embed
      → Chat model            # Bonsai / Qwen / Hosted — open chat only
  → tool receipt (confidence + suppressed_calls)
  → optional extract → Mission Envelope fields
```

| Path | Model | Output |
| --- | --- | --- |
| Named tool / forced trigger | Needle (router lease) | `function_calls` or `suppressed_calls` |
| Structured field fill | Needle `extract` | Typed object; no chat essay |
| Open chat / explain / write | Bonsai / Qwen / Hosted | Thread text. Needle stays out |
| Ambiguous | Confirm or silence | Never wake the wrong Second |

Second is the coordinator. Needle is a specialist harness under
Second, same class as CUA / Codex / browser — **not** a co-equal
personal agent and **not** a second Second.

Extraction grammar: Mission Envelope field fill and receipt parse
without a big model. New nodes stay `proposed` until accept
([ROOM-PLAN-TREE-V0.md](ROOM-PLAN-TREE-V0.md)). Extract ≠ accept.

---

## 8. Compute / Ask boundary

| Product | Needle role |
| --- | --- |
| **Ask** | None. Not a chat model. Do not add `needle-3` to `#ask-model`. |
| **Compute Provide** | Optional later Community **edge** kit: phones / Pi / wearables. Catalog id `needle-3` only after an OpenAI-tools wrap. Honesty: `route=community-tools`. |
| **Room / Second** | Pre-router + receipt fields + trigger rung + capacity leases (this spec). |

Fold lock holds ([FOLD-COMPUTE-ROOM.md](FOLD-COMPUTE-ROOM.md)):
engines stay separate. Room may call Compute as a tool; a Needle
Provide job may *correlate* to a Work Item. It does not satisfy
`room.receipt.v1` by itself.

---

## 9. Required receipts (this fold)

| Kind / field | When |
| --- | --- |
| `room.receipt.v1` + `tool.confidence` | Every Needle (or Needle-shaped) tool hop |
| `tool.suppressed_calls` | When the floor withholds; empty array if none |
| `tool.triggersMatched` | When a trigger forced the route |
| `tool.decision` | `act` · `confirm` · `refuse` |
| `disclosure.deny` | Secretary block (existing) |
| `tool.lease` | Ladder / exposed-set change (P1, existing) |

All cite prior envelopes where applicable. No orphan claims. No
secrets in `summary`.

---

## 10. Acceptance checks

- [ ] A tool receipt can carry `confidence` and `suppressed_calls`
      without a live writer
- [ ] Act / confirm / refuse is derivable from those fields +
      authority (fixtures, not UI)
- [ ] A trigger match is a Smart Routing deterministic rung; 0\|1
      wake still holds
- [ ] Intelligence ladder maps to `lease.router` →
      `lease.implement`, not to Ask model ids
- [ ] Second pre-router sends tools/extract to Needle and open chat
      to Bonsai/Qwen — in copy and fixtures, never Genie
- [ ] Needle is absent from Ask chat-model lists
- [ ] No Phase 0 #8 / #9, Muse UI, or runtime in this fold

---

## 11. Stay-outs

`client/` · `cloudflare/` · `server/` · `src/` · `deploy/` · Connect
door HTML · People rail · Done-chip chrome · Muse canvas · Phase 0
#8 / #9 · Quill trees · Compute Start · Ask `#ask-model` catalog ·
people-data · Potter keys · live writer · forking Cactus into the
Worker · MCU claims on getdasha Macs · listing Needle as GPT-class
chat · calling Second a Genie.

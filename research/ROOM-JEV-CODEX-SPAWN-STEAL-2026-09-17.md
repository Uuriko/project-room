# Steal: Codex same-rung spawn + TypeSafe Jev (2026-09-17)

**Source:** [vechen / @miu21590](https://x.com/miu21590/status/2100630512536564085)
(17 Sep 2026, ~36k impressions). Repo in replies:
[miuuyy/codex-chatgpt-web](https://github.com/miuuyy/codex-chatgpt-web)
(MIT; ChatGPT Web as a Codex model — separate Web quota, not Codex
Work quota).

**Jev (not the same product as Browser Use “Jev Ultrafast”):**
TypeSafe System One evaluation model on Vercel AI Gateway —
[`typesafe-ai/jev`](https://vercel.com/ai-gateway/models/jev). No text
generation. Input = shared `state` + typed `questions` (boolean /
choice / score). Output = answers + probabilities in parallel. Gateway
price ~$0.042 / 1M input tokens; max output tokens 0. Latency claim
~70–500ms. SDK: AI SDK 7 `experimental_evaluate`.

Docs only. Product personal-agent noun stays **Second** — never Genie
([ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)). Named specialist
nicknames (shot/log: Schrödinger / Parfit) are `seat.kind=room` labels,
not a second personal agent and not a mascot product.

Contracts this fold patches: [ROOM-SCORER.md](../docs/ROOM-SCORER.md) ·
[ROOM-PERSONAS-FACTORY.md](../docs/ROOM-PERSONAS-FACTORY.md) ·
[ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md).
Spine: [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md).
Master plan:
[ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md).

No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No Muse UI. No
runtime.

---

## What happened

Inside Codex (ChatGPT Web — Pro Ultra), asking how to use **Jev**
caused the parent agent to **spawn multiple same-rung sub-agents**
that all used the smartest available model (GPT 6 Pro). The Codex
usage meter stayed **0%** because the run rode a **separate Web
quota**. The launcher’s Compatibility V1 / Native subagent protocols
are how Codex Web children `spawn_agent` without burning Work quota.

Jev in that log is a constrained **decision** model: choose among
predefined options with distribution-derived confidence; no free-form
text. Useful for retrieval / action selection / rubric score — not
chat.

Prior note (Gateway facts): this file absorbs
`TYPESAFE-JEV-VERCEL-GATEWAY.md`. Skillbox already named Jev as a kit
router ([ROOM-STEALS-WARP-SKILLBOX-HARNESS-2026-09-17.md](ROOM-STEALS-WARP-SKILLBOX-HARNESS-2026-09-17.md)).

---

## Steals for Project Room / Compute

### P0 — Room

1. **Same-rung factory spawn** — Second or factory `foreman` may spawn
   N specialist `room` seats on the **same Roy ladder rung** (not
   always cheaper models). Nautilo’s Conductor / Floor Manager is the
   cousin for *who wakes*; this steal is *who is spawned and at what
   rung*. Receipt: `delegation.spawn` with `parentReceiptId`,
   `modelRung`, `role`, `sameRung`.
2. **Named specialist seats** — nicknames on spawn (not anonymous
   workers). Later People-rail face + receipt graph. Nickname is
   display skin; `seat.kind` stays `room`. Never rename Second. Never
   Genie.
3. **Quota / meter honesty** — surface which bill a seat burns
   (`hosted` | `community` | `web`). Ask/Compute already separates
   Hosted vs Community Mac; Room should label seat spend the same way.
   Do **not** productize Web-quota tricks on getdasha.

### P0 — Compute / Ask (research; not a Compute Start blob)

4. **Jev as pre-Ask gate** (cheap): route Hosted vs Community vs
   refuse; classify intent (code / bug / explain) for starter chips /
   model-pill defaults. Parallel questions per state (Jev evaluates
   the whole question map in one call).
5. **Jev as Room Scorer rung** — Warp-style judge for closed-set
   dimensions (orphan-claim / honesty) when a text essay is overkill.
   Keep the LLM judge for open-ended rubrics (efficiency, procedure).

### P1

6. Skill pack: `npx skills add typesafe-ai/skills --skill typesafe-ai`
   for agents that integrate Jev. Do not invent TypeSafe keys in chat.
7. Parallel question fan-out for Capacity-board eligibility checks
   (exposed vs eligible tools; host/provider slots).

---

## `delegation.spawn` (research shape)

Sibling of `delegation.messenger` ([ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)
§11). Cites the parent envelope / receipt. Orphan spawn = fail
([orphan-claim](../docs/examples/scorers/orphan-claim/scorer.md)).

```json
{
  "kind": "delegation.spawn",
  "version": 1,
  "parentSeatId": "seat_…",
  "parentReceiptId": "rcp_…",
  "childSeatId": "seat_…",
  "nickname": "Schrödinger",
  "role": "triage|implementation|review|scorer",
  "modelRung": "fast-default|quality",
  "sameRung": true,
  "meter": "hosted|community|web",
  "citesEnvelopeId": "env_…",
  "completedAt": "ISO-8601"
}
```

| Field | Rule |
| --- | --- |
| `parentReceiptId` | Prior receipt / envelope the parent cited when spawning. Required for a citable spawn. |
| `nickname` | Display label only. No people-data. Not a product noun. Not Genie. Not Second. |
| `role` | Factory persona the child claims ([ROOM-PERSONAS-FACTORY.md](../docs/ROOM-PERSONAS-FACTORY.md)). |
| `modelRung` | Honest Roy pin. Same-rung spawn sets `sameRung: true`. Never rename a model to hide a limit. |
| `meter` | Which bill this seat burns. `web` is honesty when a harness rides a separate Web/Codex-class quota — not a Room feature. |

Second remains the coordinator. Spawned specialists are tools under
the ledger unless invited as members. Smart Routing still wakes **0 or
1** seat per inbound human message unless the human explicitly
addresses more.

---

## Jev rung (scorer + router)

| Use | Why Jev fits | Keep LLM when |
| --- | --- | --- |
| Orphan-claim / people-data-safe | Closed labels already; boolean + choice + score | Trace is open-ended prose the rubric must read as an essay |
| Kit recommend | `recommend_kits(query) → [{ id, score }]` already on the kits contract | No TypeSafe / Gateway key (inert + reason) |
| Pre-Ask / Compute route | Cheap gate before Mac spend; parallel questions | Operator wants a written refusal, not a label |
| Capacity eligibility | Many booleans per host/provider state | Slot math is deterministic (no model) |

`scorers/<slug>/scorer.md` `model` may pin `jev` for closed-set
dimensions. Absent key → Roy `fast-default` LLM judge. Same 3–5%
token bound: Jev is how we *stay* inside it.

**Calibrate.** Workflow evals measure agreement with frontier
consensus, not ground truth. Score Jev against labeled Room receipts
before treating `probability` as a ship gate.

Do not replace Ask chat with Jev. Jev has no text generation.

---

## Meter honesty (Room + Compute)

Ask / Compute already say hosted vs community. Room should label
**each spawned seat**:

| Meter | Burns | Honesty |
| --- | --- | --- |
| `hosted` | Operator / getdasha hosted run | Show hosted. |
| `community` | Community Mac / BYO host | Show community + the actual model on that Mac. |
| `web` | Separate Web / Codex-class quota (Codex ChatGPT Web pattern) | Label the split. Do not advertise “0% Codex” as a product win. |

Capacity board (later) shows N claims **and** which meter each claim
is on. Fail-loud when a meter is exhausted — same as hraness limit
honesty ([ROOM-HRANESS-STEAL-2026-09-17.md](ROOM-HRANESS-STEAL-2026-09-17.md)).

---

## Naming lock

| Do say | Don’t say |
| --- | --- |
| “Your Second spawned Schrödinger (review, same rung).” | “Your Genie spawned a Genie.” |
| “Named specialist seat” | “Second personal agent” for a factory child |
| “`delegation.spawn`” | Opaque “the swarm handled it” |
| “This seat is on Community / Hosted / Web.” | Hide the bill behind a 0% parent meter |

Optional local rename/voice is skin on **Second** only. Specialist
nicknames do not mint a new personal-agent product.

---

## Skips

- Do not replace Ask chat with Jev (no text generation).
- Do not pretend Web-quota tricks are a product feature on getdasha.
- Do not invent TypeSafe API keys in chat.
- Do not ship Phase 0 #8 / #9, Muse People-rail / Connect HTML, or
  scorer/factory runtime in this fold.
- Do not treat specialist harnesses (Codex / Claude Code / CUA) as
  co-equal personal agents.
- Do not confuse TypeSafe Jev with Browser Use “Jev Ultrafast”.

---

## Ship next (no-collide)

1. This research note + light patches on scorer / factory / Jev-Roy /
   Second receipts / indexes.
2. Later Muse: named specialist chips + meter label (not this PR).
3. Later runtime: `delegation.spawn` writer + Jev pin on
   orphan-claim — after Muse board / kit ACK.

---

## Related

| Path | Role |
| --- | --- |
| [ROOM-SCORER.md](../docs/ROOM-SCORER.md) | Jev cheap closed-set rung |
| [ROOM-PERSONAS-FACTORY.md](../docs/ROOM-PERSONAS-FACTORY.md) | Same-rung spawn + named seats + meter |
| [ROOM-KITS-HARNESS-JEV-ROY.md](../docs/ROOM-KITS-HARNESS-JEV-ROY.md) | Jev recommend + router + scorer |
| [ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) | `delegation.spawn` beside messenger |
| [ROOM-RECEIPT-GRAPH-V0.md](../docs/ROOM-RECEIPT-GRAPH-V0.md) | Spawn cites parent |
| [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md) | SoR |
| [ROOM-STEALS-FULL-BUILD-2026-09-17.md](ROOM-STEALS-FULL-BUILD-2026-09-17.md) | Master plan index |

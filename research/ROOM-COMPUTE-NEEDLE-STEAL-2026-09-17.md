# Cactus Needle 3 — steal note (2026-09-17)

**Source:** https://cactuscompute.com/needle

**Status:** research only. Docs, not a live door. Product personal-agent
noun stays **Second** — never Genie
([ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)).

Product spec this fold:
[ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](../docs/ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md).
Spine: [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md).
Receipts: [ROOM-RECEIPT-V1.md](../docs/ROOM-RECEIPT-V1.md). Smart Routing:
[ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md) §6. Jev pair:
[ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md](ROOM-JEV-CODEX-SPAWN-STEAL-2026-09-17.md).
Ask quiet-shell (separate product):
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md).

No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No Muse UI. No
runtime.

---

## What it is

Automation / tool-calling foundation model for **tiny devices** (phones,
wearables, robots, smart home, Pi, MCU). Not a general chat LLM.

- One CQ2 binary **8–29 MB**; **intelligence ladder** = every depth
  2L→20L is a usable subnetwork
- Jobs: tool calls (multi, ordered, empty on no-match), structured
  extraction (grammar), text embeddings
- Speeds claimed: ~400–4k tok/s decode on Pi 5; peak RAM tens of MB
- API: `needle.tool` decorators, `triggers` regex, `confidence` +
  `suppressed_calls`, `extract(Pydantic)`

Every turn returns `function_calls`, a calibrated `confidence`, and
(when the engine floor withholds a call) `suppressed_calls`. A tool
with `triggers` always produces a call for a matching request; the
score then decides act vs confirm. Below the engine floor (~0.1) the
call is withheld into `suppressed_calls` and `function_calls` is empty.

---

## Steal for Dasha Compute

| Do | Don’t |
|---|---|
| Optional **edge Provide** kit: `needle-3` as Community **tool-call / extract** specialist (not Ask chat hero) | Don’t list it as a chat model next to Bonsai/Qwen |
| Market to phones/Pi/wearable providers — fills a rung our 4B–27B chat ladder misses | Don’t replace Hosted gpt-oss or Bonsai |
| Ship honesty: route=`community-tools`, not OpenAI chat completions unless wrapped | Don’t pretend Needle is GPT-class chat |

Needle is **not** an Ask chat model. Optional Compute edge Provide is
later, after a wrap as an OpenAI-tools compatible backend.

---

## Steal for Project Room / Second

1. **Confidence-gated tool floor** → Room receipt fields `confidence`,
   `suppressed_calls` (pairs with Jev scorers)
2. **Trigger regex / forced route** → Smart Routing when intent must
   hit a named tool
3. **Intelligence ladder** → progressive capacity leases (small router
   → deeper implement)
4. **Local Second pre-router** on Mac/phone: Needle decides tools;
   Bonsai/Qwen only for open chat
5. **Extraction grammar** → Mission Envelope field fill / receipt parse
   without a big model

---

## Skip

- Replacing Roy chat ladder with Needle
- Listing Needle as an Ask chat model next to Bonsai / Qwen
- Forking their engine into dasha-lobby Worker
- Claiming MCU support on getdasha Macs
- Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
  [#9](https://github.com/Uuriko/project-room/pull/9)
- Muse People-rail / Connect chrome
- Runtime / Worker / `client/` `cloudflare/` `server/` `src/` in this
  fold

---

## Next (if Potter says go)

1. `pip install cactus-needle` on Mac → smoke tool-call + extract
   (operator laptop; not this repo)
2. Docs-only Room steal PR (confidence + triggers) — **this file +
   [ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](../docs/ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md)**
3. Optional Compute catalog id `needle-3` after wrap as OpenAI-tools
   compatible backend (not Ask chat; not this PR)

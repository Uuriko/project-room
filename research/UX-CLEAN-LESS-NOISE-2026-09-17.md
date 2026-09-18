# UX clean / less noise — Ask + Compute + Room (2026-09-17)

**Status:** research only. Docs, not a live door. Product personal-agent
noun stays **Second** — never Genie
([ROOM-SECOND-V0.md](../docs/ROOM-SECOND-V0.md)).

Ask P0 product spec this fold:
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md).
Needle-shaped tool confidence (Room P2, separate contract):
[ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](../docs/ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md).
Spine: [ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md).
Quiet craft cousins: [PROJECT-ROOM-DESIGN-GUIDE.md](PROJECT-ROOM-DESIGN-GUIDE.md),
[QUIET-PRODUCT-DESIGN-PLAN-2026-09-08.md](../docs/QUIET-PRODUCT-DESIGN-PLAN-2026-09-08.md).

Research: Claude / ChatGPT / Perplexity / Cursor / Linear / agent-UI
progressive disclosure (tianpan, aiuxdesign, designpixil).

No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No Muse UI. No
runtime.

---

## Executive: ranked changes

### Ask (P0) — make the thread win

1. **One primary surface**: full-viewport thread + sticky composer.
   Kill Typeform `Do.` / `Start.` H1s and door-row chrome on first paint
   (already in dasha-lobby
   [#246](https://github.com/Uuriko/dasha-lobby/pull/246) /
   [#249](https://github.com/Uuriko/dasha-lobby/pull/249) tip —
   **prove live after Instinct deploy**).
2. **Chrome ≤15%**: Claude/ChatGPT rule — tonal separation, not
   borders; one accent (acid) only for primary send / active state.
3. **Quiet model chip**: model name inside composer (Claude
   Sonnet-in-bar), not a loud picker row. ⌘K / click opens list.
4. **Hover actions only**: Copy / Regen / Edit appear on hover (or
   focus), not permanent icon rails under every message. Keyboard
   map (T082):
   [ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md)
   — Esc Stop · R Regen · C Copy · E Edit. Picker keys stay T032.
5. **Empty state = 1 line + ≤4 starters**: no Provide/Marketplace/Host
   marketing on Ask canvas; those stay quiet nav links.
6. **Streaming status one word**: “Thinking…” / stop — no tok/s /
   provider essay mid-stream.

### Ask (P1) — new features that reduce noise

7. **Artifacts panel** (Claude): long code/markdown opens beside
   thread, not as a scroll bomb inside the bubble.
   **Lite P0** (collapse + opt-in panel) is
   [ASK-ARTIFACTS-LITE-2026-09-18.md](ASK-ARTIFACTS-LITE-2026-09-18.md);
   implement gate (T081, cite #493/#507):
   [ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md](ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md);
   `#ask-thread` GFM subset (T085, cite T041 #269):
   [ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md](ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md)
   — fences / lists ship; links stay plain;
   auto-open / HTML preview stay P1.
8. **History sidebar icon-only** until hover; auto-title chats; search
   later.
9. **Follow-up chips** after reply (3 max), not a second door row.
10. **Branch from edit** (ChatGPT): edit+resend forks quietly; no
    “you edited” banners.

### Compute Provide / network (P1)

11. **Provide = secondary door**: never compete with Ask first paint;
    Typeform Provide stays off Ask canvas. Boundary (T074):
    [ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md](ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md).
12. **Network honesty strip**: one line `N Macs · models` expandable —
    not a capacity dashboard on Ask. `#ask-receipt` Job whisper
    (T087, cite T045
    [#496](https://github.com/Uuriko/project-room/pull/496):
    [ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md](ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md))
    is a per-turn chip, never that dash.
13. **Model ladder labels**: Speed / Mid / Quality (map qwen3-4b /
    8b+12b / bonsai) — hide raw ids until advanced. Placement (T075):
    [ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md](ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md)
    — picker in composer `#ask-model` → later `#ask-cmdk`; never a
    model essay on the empty canvas.

### Project Room (P2 — separate product)

14. **Tiered agent transparency**: Tier1 step labels (“Searched
    calendar”), Tier2 expandable reasoning, Tier3 inspector only.
15. **Collapsible tool blocks** (Harbour/Captain pattern): “N tools”
    summary, not raw JSON.
16. **Needle-shaped confidence**: show act / confirm / refuse from
    confidence — not every tool fire. Spec:
    [ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](../docs/ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md).

---

## Steal table

| Source | Take | Skip |
|---|---|---|
| ChatGPT | History as workspace; edit/regen; chrome subtraction | Emerald brand wash; feature grids |
| Claude | Artifacts; warm empty; model in composer; icon sidebar | Long marketing empty states |
| Perplexity | Citations as first-class when we have sources | Trending-topics homepage |
| Cursor | Accent only on AI affordances; propose→apply | IDE density on web Ask |
| Linear | Progressive disclosure; hover actions; 4px grid | Issue-tracker chrome |
| Agent UI research | Lifecycle steps not token dumps | Always-on tool JSON |
| Needle | Confidence gate for tools | Listing as Ask chat model |

---

## Anti-noise rules (never)

- No Typeform H1 + door row on Ask first paint
- No permanent action icon row under every message
- No tok/s / kit version / provider essay in the thread
- No honesty lectures / disclaimer blocks
- No second primary CTA competing with Send
- No more than one accent color for actions
- No dumping Provide/Host/Marketplace into Ask empty state

---

## Ask v3 “quiet shell” sketch

Preserve IDs: `#step-ask`, `#ask-input`, `#ask-send`, `#ask-model`,
stream contracts.
Visual: black canvas, paper text, acid send only; composer bottom;
messages max-width ~42rem; hover toolbar; New chat quiet top-right
(T084 confirm if the thread has turns:
[ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md](ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md)
— never wipe without Esc/cancel); Export MD is a thread
**download**, not per-turn Copy (T086, cite T044
[#496](https://github.com/Uuriko/project-room/pull/496):
[ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md](ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md)).
Deploy gate: tip
[#246](https://github.com/Uuriko/dasha-lobby/pull/246) /
[#249](https://github.com/Uuriko/dasha-lobby/pull/249) must be live
first, then v3 polish PR.

Canonical sketch:
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md).

---

## Stay-outs

Quill login [#247](https://github.com/Uuriko/project-room/pull/247) ·
Muse [#225](https://github.com/Uuriko/dasha-lobby/pull/225) paper
faces · Instinct Phase 0
[#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9) ·
Designer-publish · people-data · Muse UI · runtime / Worker /
`client/` `cloudflare/` `server/` `src/` in this fold

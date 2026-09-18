# ASK-QUIET-SHELL-V3 — Ask quiet shell (P0)

17 September 2026. Product spec. Docs only. Not a live Ask rewrite.

Make the **thread** win. Chrome ≤15%. Model lives in the composer.
Actions appear on hover. Empty state is one line and ≤4 starters.
Preserve `#step-ask` / `#ask-input` / `#ask-send` / `#ask-model` and
the stream contracts.

**Deploy gate:** dasha-lobby tip
[#246](https://github.com/Uuriko/dasha-lobby/pull/246)
(Claude/ChatGPT-minimal thread + composer) and
[#249](https://github.com/Uuriko/dasha-lobby/pull/249)
(Stop / Regen / Copy / Edit / MD / New) **must be live on Instinct
deploy before any v3 polish PR.** Those tips already killed Typeform
`Do.` / `Start.` H1s and the door-row first paint. v3 is subtraction
and density — not a second first-paint rewrite.

Research:
[UX-CLEAN-LESS-NOISE-2026-09-17.md](../research/UX-CLEAN-LESS-NOISE-2026-09-17.md).
Quiet cousins: [QUIET-PRODUCT-DESIGN-PLAN-2026-09-08.md](QUIET-PRODUCT-DESIGN-PLAN-2026-09-08.md),
[QUIET-FAST.md](QUIET-FAST.md),
[PROJECT-ROOM-DESIGN-GUIDE.md](../research/PROJECT-ROOM-DESIGN-GUIDE.md).
Needle is **not** an Ask chat model:
[ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md).
Fold lock: [FOLD-COMPUTE-ROOM.md](FOLD-COMPUTE-ROOM.md).

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door, not Room chrome, and not a Second surface.

No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No Muse UI. No
runtime in this repo.

---

## 1. One line

Ask is a full-viewport thread with a sticky composer. Everything else
is quiet.

---

## 2. Why

Claude / ChatGPT / Linear teach the same subtraction: tonal
separation instead of borders, one accent, hover for secondary
actions, a warm empty that does not sell the rest of the product.

#246 / #249 already moved Ask off Typeform. Live tip still needs
Instinct deploy. Until that tip is proven live, v3 polish must not
land. After it is live, v3 tightens chrome, moves the model chip
fully into the composer, hides per-message actions until hover/focus,
and caps the empty state at four starters.

---

## 3. P0 — make the thread win

### 3.1 One primary surface

- Full-viewport thread + sticky composer.
- Cold `#step-ask` is already chat. No Typeform `Do.` / `Start.` H1.
- No door-row chrome on first paint. Provide / Host / Marketplace
  stay quiet nav links, never a second primary CTA.
- After first turn, the thread dominates. Extra doors stay in More.

### 3.2 Chrome ≤15%

Claude/ChatGPT rule. Measure chrome as the non-thread, non-composer
paint (header, nav, pills, status) on a desktop Ask viewport.

- Tonal separation, not borders.
- One accent (acid) only for primary send / active state.
- No second accent on model, New, or hover actions.
- No honesty lectures / disclaimer blocks on the canvas.

### 3.3 Quiet model chip

- Model name lives **inside the composer** (Claude Sonnet-in-bar).
- Not a loud picker row. Not a Typeform “Which model?” step.
- Click or ⌘K opens the list. `#ask-model` stays the control.
- Raw ids stay advanced. Face labels may be Speed / Mid / Quality
  later (P1). Needle / `needle-3` is **not** in this list.

### 3.4 Hover actions only

- Copy / Regen / Edit appear on hover or keyboard focus.
- No permanent icon rail under every message.
- Stop while streaming remains the composer primary (from #249 A1).
- Focus-visible hit targets stay ≥24px; hover-only is not an excuse
  to drop keyboard access.

### 3.5 Empty state = 1 line + ≤4 starters

- One greeting line. No Provide / Marketplace / Host marketing.
- At most **four** starter chips.
- Those chips start a thread. They do not open other products.

### 3.6 Streaming status one word

- “Thinking…” / Stop.
- No tok/s, kit version, or provider essay mid-stream.
- Per-turn states from #249 (thinking / streaming / complete /
  stopped / error) stay. The **visible** word is one.

---

## 4. Visual sketch

| Token | v3 |
| --- | --- |
| Canvas | Black |
| Text | Paper |
| Accent | Acid, send / active only |
| Composer | Sticky bottom |
| Messages | Max-width ~42rem |
| Toolbar | Hover / focus on the turn |
| New chat | Quiet top-right (`#clear-chat` / New from #249) |

No emerald brand wash. No feature grid. No IDE density.

---

## 5. IDs and stream contracts (preserve)

Canonical v3 selectors — do not break tests or stream wiring:

| ID | Role |
| --- | --- |
| `#step-ask` | Ask surface. Cold first paint. Stay here. |
| `#ask-input` | Composer field (alias `#prompt` from #246/#249 until a coordinated rename) |
| `#ask-send` | Primary send / Stop (alias `#run-demo` from #246/#249 until a coordinated rename) |
| `#ask-model` | Quiet model chip inside the composer |

Also keep (tip already ships): `#ask-thread`, `#ask-think`,
`#ask-run-chip`, `#change-engine`, `#clear-chat`, `#login`.
`#step-model` may remain in the DOM as an inert leftover; v3 must
not return the user there.

Stream contracts stay: live user + assistant on send; AbortController
stop; partial text kept; markdown + stream-safe incomplete fences.
v3 does not reopen the Typeform model step.

---

## 6. Anti-noise rules (never)

- No Typeform H1 + door row on Ask first paint
- No permanent action icon row under every message
- No tok/s / kit version / provider essay in the thread
- No honesty lectures / disclaimer blocks
- No second primary CTA competing with Send
- No more than one accent color for actions
- No dumping Provide / Host / Marketplace into Ask empty state
- No Needle / `needle-3` in `#ask-model`

---

## 7. Out of v3 P0 (later)

From the research note. Do not sneak them into the polish PR.

| # | Item | When |
| --- | --- | --- |
| 7 | Artifacts panel beside the thread | Ask P1 |
| 8 | History sidebar icon-only | Ask P1 |
| 9 | Follow-up chips after reply (3 max) | Ask P1 |
| 10 | Branch from edit (quiet fork, no banner) | Ask P1 |
| 11 | Provide as secondary door (keep off Ask canvas) | Compute P1 |
| 12 | Network honesty strip `N Macs · models` | Compute P1 |
| 13 | Speed / Mid / Quality ladder labels | Compute P1 |
| 14–16 | Room tiered transparency / collapsible tools / Needle confidence | Room P2 — [ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md) |

#249 already shipped Stop / Regen / Copy / Edit / Enter+Shift+Enter /
stream-safe MD / New. v3 **does not restyle those into a new product**.
It hides the actions until hover and finishes the chrome budget.

---

## 8. Deploy gate

1. Instinct deploys dasha-lobby
   [#246](https://github.com/Uuriko/dasha-lobby/pull/246) and
   [#249](https://github.com/Uuriko/dasha-lobby/pull/249) to the live
   Ask door.
2. Prove first paint: `#step-ask` is chat; no `Do.` / `Start.` H1;
   no door row; `#ask-model` is a chip, not a step.
3. **Then** a v3 polish PR may land (chrome ≤15%, hover actions,
   empty ≤4, composer model chip).
4. This repository ships the spec only. No wrangler. No
   Designer-publish. No `plugin.jup.ag`.

---

## 9. Acceptance checks

- [ ] Tip #246 / #249 proven live before v3 polish
- [ ] `#step-ask`, `#ask-input`, `#ask-send`, `#ask-model` exist
      (aliases allowed for `#prompt` / `#run-demo`)
- [ ] Stream contracts unchanged (stop, partial keep, MD fences)
- [ ] Chrome ≤15% on a desktop Ask viewport
- [ ] Model chip is inside the composer; no picker row
- [ ] Copy / Regen / Edit are hover-or-focus only
- [ ] Empty state is one line + ≤4 starters; no Provide/Host/Marketplace
- [ ] Visible stream status is one word
- [ ] Needle absent from `#ask-model`
- [ ] No Phase 0 #8 / #9, Muse UI, or runtime in this fold

---

## 10. Stay-outs

Quill login [#247](https://github.com/Uuriko/project-room/pull/247) ·
Muse [#225](https://github.com/Uuriko/dasha-lobby/pull/225) paper
faces · Instinct Phase 0
[#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9) ·
Designer-publish · people-data · Muse UI · Room People-rail ·
Connect door HTML · Compute Start blob · Needle as Ask chat ·
`client/` `cloudflare/` `server/` `src/` in **this** repo ·
calling Second a Genie.

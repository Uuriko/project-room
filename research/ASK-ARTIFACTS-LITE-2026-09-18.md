# Ask Artifacts-lite — Dasha Compute Ask (getdasha)

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask**  
**Status:** research only. Docs, not a live door. **P0 scope only.**  
**Plan ref:** T034  
**Baseline tip:** `Uuriko/dasha-lobby` [#246](https://github.com/Uuriko/dasha-lobby/pull/246) /
[#249](https://github.com/Uuriko/dasha-lobby/pull/249) /
[#255](https://github.com/Uuriko/dasha-lobby/pull/255) merged —
**LIVE** may still be Typeform until Instinct wrangler  
**Companions:** [ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md) ·
[UX-CLEAN-LESS-NOISE-2026-09-17.md](UX-CLEAN-LESS-NOISE-2026-09-17.md) ·
[ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md)

Fold lock: [FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).
Room “artifact” (editorial rung on a Done receipt) is a **different
noun**: [ROOM-ARTIFACT-MATURITY.md](../docs/ROOM-ARTIFACT-MATURITY.md).

No Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9). No Muse UI. No
runtime. No dasha-lobby Worker HTML in this fold.

---

## 0. One line

Long code fences collapse in the thread. **Expand** or **Open panel**
(side on desktop, bottom when narrow) to read them. Empty Ask stays
empty.

---

## 1. Problem

Ask’s job is a quiet thread. An 80-line `python` fence in the bubble
blows `#ask-thread`: the turn becomes a scroll bomb, hover actions
drift off-screen, and the next prompt is a page away. Quiet-shell v3
can hide Copy / Regen / Edit and still lose the thread to one fence.

This is already true on tip #246 / #249 / #255 (stream-safe MD
renders fences inline). Live edge may still be Typeform; the problem
is the same the moment chat MD ships.

Do **not** solve it by stuffing Compute Ask into Project Room
receipts or the maturity ladder. Ask is Compute’s chat door. Room
Done artifacts stay Work Item evidence.

---

## 2. Pattern steals

| Source | Take (lite / P0) | Skip (not P0) |
| --- | --- | --- |
| **Claude Artifacts** | Long self-contained output leaves the bubble; language chip; Copy; side panel on desktop | Auto-open on every long output; live HTML/React preview; Publish / share URL; Artifacts library; version slider |
| **ChatGPT canvas** | Side / bottom workspace for one long block; collapse the inline dump | Full canvas editor; reading-level toolbar; selection rewrite; Execute / console; multi-tab documents |
| **Cursor preview** | Collapsed fence with language chip + Copy; Open to read | IDE density; apply / diff; file tree; multi-file tabs; Monaco; terminal |

Lite = **collapsed fence → opt-in panel**. Not Claude’s auto-split
workspace. The **full** Artifacts panel (auto-open, HTML preview,
library) stays quiet-shell §7 item 7 — Ask **P1**.

---

## 3. P0 UX

**Trigger:** a **closed** markdown fence whose body is **> N lines**.
Recommended **N = 16** (Claude’s ~15-line “self-contained” trigger,
even 16-line grid). Short fences stay inline. Implement may tune N.
Do **not** collapse mid-stream: stream-safe incomplete fences stay
visible until the fence closes.

Collapsed fence (in the bubble):

- **Language chip** from the info string (`python`, `js`, `md`, or
  `plain` when missing). Quiet, not acid.
- First line or `N lines` as the title — not a filename essay.
- **Expand** — inline, still in the bubble (no panel).
- **Open panel** — desktop (≥ ~800px): side of `#step-ask`; narrow:
  bottom sheet above the composer. One panel at a time.
- **Copy** — fence body only (not the whole turn). Same clipboard
  path as #249 Copy. No second accent.

Panel chrome (only after Open panel):

- Same language chip + Copy.
- Close / Esc returns focus to `#ask-thread`; **never** clears the
  thread.
- Read-only, scrollable. Syntax color only if tip already colors
  fences. No edit surface.

**Empty Ask: no panel, no Artifacts icon, no collapsed-fence
chrome.** The panel is a consequence of a long fence, not a standing
product surface.

Several long fences in one turn: each collapses independently. The
panel shows the last one the user opened. Do not auto-advance.

---

## 4. Quiet-shell fit

v3: chrome ≤15%; empty = 1 line + ≤4 starters; hover actions; no
second primary CTA.

Artifacts-lite must not re-break that:

- No new chrome on the **empty** canvas.
- No permanent Artifacts rail, library button, or “Workspace” tab.
- Panel is **opt-in**. Auto-opening a side pane would steal the
  thread (that is the P1 full-Artifacts steal).
- Collapsed-fence actions live on the fence, not as a new icon row
  under every message.
- Acid stays on Send / active only. Language chip is paper / muted.
- `#ask-model` ⌘K
  ([ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md))
  is unrelated; do not hang the panel off the model chip.

Preserve: `#step-ask` `#ask-input` `#ask-send` `#ask-model`
`#ask-thread` `#prompt` `#run-demo` and stream contracts (stop,
partial keep, incomplete fences).

Additive IDs (implement later, **dasha-lobby only**):
`#ask-artifact-panel`, `[data-ask-fence]`,
`[data-ask-fence-collapsed]`.

---

## 5. Non-goals (not this P0)

- Full IDE (file tree, tabs, apply / diff, Monaco, terminal)
- Room collision (Work Items, receipts, maturity rungs, People-rail,
  Second). An Ask panel is not a Room artifact.
- Hosting or executing arbitrary HTML, React, SVG, or Mermaid in the
  panel (XSS + Claude Publish merge)
- Auto-open panel, Artifacts library, public share URLs
- Editing the fence in the panel, or “iterate this artifact” as a
  separate object
- Provide / Host / Marketplace / Needle as panel chrome
- dasha-lobby Worker HTML in **this** repository / this PR

---

## 6. Success tests (later dasha-lobby implement)

### Must

- [ ] Fence ≤ N lines stays fully inline
- [ ] Closed fence > N lines renders collapsed (language chip +
      count + Expand / Open panel / Copy)
- [ ] Expand shows the fence inline; thread not cleared
- [ ] Open panel: side ≥ ~800px, bottom sheet when narrower; one
      panel; Esc / close restores focus
- [ ] Copy writes the fence body only
- [ ] Incomplete / streaming fence does not collapse until closed
- [ ] Empty `#step-ask` has no `#ask-artifact-panel` and no
      Artifacts icon
- [ ] `#step-ask` `#ask-input` `#ask-send` `#ask-model` preserved
- [ ] Hover Copy / Regen / Edit on the turn still work
- [ ] less-is-more + ask-chat-ux (+ v2) + quiet-shell suites stay
      green

### Must not

- [ ] Execute or iframe untrusted HTML from the fence
- [ ] Write Room receipts / Work Items / maturity rungs
- [ ] Quill / Muse / Phase 0 #8 / #9 / Designer-publish /
      people-data / `plugin.jup.ag` / Potter keys / direct wrangler
- [ ] New chrome on empty Ask

---

## 7. Ship path

1. **This note** — docs-only on `Uuriko/project-room`.
2. **Implement** — later, `Uuriko/dasha-lobby` only, after Instinct
   proves #246 / #249 / #255 live. Not this PR. No wrangler from the
   note author.

---

## 8. Stay-outs

Quill login [#247](https://github.com/Uuriko/project-room/pull/247) ·
Muse [#225](https://github.com/Uuriko/dasha-lobby/pull/225) paper
faces · Instinct Phase 0
[#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9) ·
Designer-publish · people-data · Potter keys · `plugin.jup.ag` ·
wrangler · Room People-rail · Connect door HTML · Compute Start blob ·
Needle as Ask chat · `client/` `cloudflare/` `server/` `src/` in
**this** repo · dasha-lobby Worker HTML in this task · calling Second
a Genie.

---

*End. Cousin: `docs/ASK-QUIET-SHELL-V3.md` §7 item 7 (full panel = P1).*

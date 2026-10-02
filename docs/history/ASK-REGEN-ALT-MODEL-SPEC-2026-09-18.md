# Ask T042 — Regenerate with alternate model (Raycast-style)

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask**  
**Status:** Spec ready · implement deferred (not this repo) · docs-only  
**Plan ref:** T042 (this spec). Implement later on `Uuriko/dasha-lobby` after Instinct tips quiet-shell live.  
**Baseline tip:** dasha-lobby `#246` / `#249` / `#255` on main (live may still lag Instinct wrangler).  
**Cousins:** [ASK-QUIET-SHELL-V3.md](ASK-QUIET-SHELL-V3.md) · [ASK-MODEL-CMDK-SPEC-2026-09-17.md](ASK-MODEL-CMDK-SPEC-2026-09-17.md) · [ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md](ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md) · T082 action keys [ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](../research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md) · box `UX-CLEAN-LESS-NOISE-2026-09-17.md`

Artifacts-lite (Ask P1 panel) may land in parallel — **different path**. Do not edit those files from this fold.

Compute ≠ Project Room. No people-data, Designer-publish, `plugin.jup.ag`, Potter keys, Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) / [#9](https://github.com/Uuriko/project-room/pull/9).

---

## 0. One line

After an assistant turn, a **hover** action re-runs the **same prompt** on a **different** Community / Hosted ladder model. Same-model Regen stays. Empty canvas stays quiet — no model dump, no Typeform `Start.`

---

## 1. Problem

`#249` A2 already ships **Regenerate** on the last `.ask-turn.mac`: `regenerateLastAsk()` reuses the last user turn and **replaces** that assistant. It always uses whatever `$('model')` is now.

Wanting another voice means: change `#ask-model`, then Regen — or New the thread. That is two steps and a composer trip. Raycast / Claude / ChatGPT let you pick the next model **from the turn**, then re-run. Ask should steal that without a picker row or a Typeform “Which model?”.

Empty Ask must not grow a MODELS table, GB/tok essays, or starter chips that are secretly model buttons.

---

## 2. Steals

| Source | Take | Skip |
| --- | --- | --- |
| **Raycast** | ⌘K / row list; pick a model then re-run the same query | Spotlight chrome, global hotkey outside Ask |
| **Claude** | Model lives in the bar; regen stays on the turn | Marketing empty; permanent action rail |
| **ChatGPT** | Regen replaces the last assistant; edit+resend truncates the tail | Emerald wash; “you edited” banners |
| **Ask v2 `#249`** | `regenerateLastAsk()`, last-user reuse, replace-not-append, `askEditAt` truncate | Permanent Regen icon |
| **Ask ⌘K T032** | Speed / Mid / Quality / Hosted face groups; empty Advanced; same `#ask-cmdk` rows | Native `<select>` scream; inventing Bonsai offline |
| **Ask quiet-shell `#255`** | Hover/focus overlay; one accent; no tok/s essay | Door-row / `Start.` first paint |

---

## 3. P0 UX

### 3.1 When

- Last assistant turn exists (`complete`, `stopped`, or `error`).
- Hover or keyboard focus on that turn (quiet-shell §3.4). Same overlay as Copy / Regen / Edit.
- **Never** on empty `#ask-thread`. **Never** as a first-paint control.

### 3.2 Controls

Keep A2 **Regenerate** (same `$('model')`). Add a quiet sibling, not a second primary:

- **Regenerate with…** (word) **or** a `▾` on Regen that opens the ladder.
- One hover cluster. No third accent. No permanent “Try Bonsai / Try Hosted” chips under the bubble.

Copy bank: `Regenerate` · `Regenerate with…` — not `Start.` · `Which model?` · `Try another model!`.

### 3.3 Ladder (reuse T032, do not fork)

Opening **with…** shows the **same** Community / Hosted face list as `#ask-cmdk`:

| Group | Face | Ids (when advertised) |
| --- | --- | --- |
| Speed | Speed | `qwen3-4b` |
| Mid | Mid | `qwen3-8b`, `gemma3-12b` |
| Quality | Quality | `ternary-bonsai-2-27b` when the network has it |
| Hosted | Hosted | `gpt-oss-20b` |
| Advanced | Advanced | **empty** (gemma3-27b demote stays `#258`, not here) |

Current id is highlighted. Filter/type-ahead allowed. Esc / outside click closes; thread uncleared. Needle / `needle-3` is **not** a row.

Prefer reusing `#ask-cmdk` (or a `data-ask-cmdk-source="regen"` open) over a second menu implementation.

### 3.4 After a pick

1. Sync `#ask-model` + `$('model')` the same path as a composer cmdk select (`paintAskModel` / `updateRun()`).
2. Flip `#engine` only when the allowlist already would (Hosted floor vs Community). No extra “switch engine?” modal.
3. Call the existing **`regenerateLastAsk()`** contract:
   - reuse last user text
   - **replace** the last assistant turn (not a second `.ask-turn.mac`)
   - stay on `#step-ask`
4. Stream chrome is v3: **Thinking…** + composer **Stop**. No tok/s / provider essay in the thread.

### 3.5 Transcript edit truncation (keep A4)

`#249` A4: Edit last user sets `askEditAt`; send with `askEditAt>=0` **truncates after that user** and drops later turns.

Alt-model regen **must** use `pendingMessages()` / the same truncated transcript. Example from the v2 suite:

`[First., One., Second., Two.]` → Edit Second → send rewrite → `[First., One., Second rewritten., rewritten ok]`.

A later **Regenerate with… Quality** on `rewritten ok` reuses `Second rewritten.` and the prefix `First. / One.` — it does **not** resurrect `Second.` / `Two.`.

Regen never sets `askEditAt`. Edit remains the only truncate trigger.

### 3.6 Empty canvas (hard)

Cold `#step-ask`: one greeting line + **≤4** starters. No MODELS dump, no Speed/Mid/Quality chips, no “pick a model to begin.” Composer `#ask-model` + T032 ⌘K/`/` remain the **only** empty-state model affordances — and they are composer chrome, not canvas.

### 3.7 Preserve IDs

`#step-ask` `#ask-input` `#ask-send` `#ask-model` `#ask-composer` `#prompt` `#run-demo` `#ask-thread` `#ask-think` `#ask-run-chip` · `regenerateLastAsk` · `askEditAt` · `.ask-act[data-act=regen]`.

**Additive (implement):** `.ask-act[data-act=regen-with]` and/or Regen `aria-haspopup` → `#ask-cmdk`. No `#step-model` revival.

---

## 4. Non-goals

- Same-model Regen rewrite (already A2).
- Side-by-side two-model compare / branch banner (quiet-shell P1 #10 is a different steal).
- Artifacts-lite panel, history sidebar, follow-up chips.
- Dumping Provide / Host / Marketplace or a model catalog on empty Ask.
- Listing Needle as an Ask chat model.
- Moving `gemma3-27b` into Advanced (dasha-lobby `#258`).
- Changing A4 truncation rules.
- Room Second / People-rail / Work Items.
- dasha-lobby Worker edits or wrangler from **this** PR.

---

## 5. Success tests (for the later lobby implement)

- [ ] Empty `#ask-thread`: no Regen, no **with…**, no MODELS / ladder rows on the canvas.
- [ ] After a complete assistant turn, hover/focus shows **Regenerate** + **with…** (or Regen `▾`).
- [ ] **Regenerate** still replaces last assistant using current `$('model')` (A2 green).
- [ ] **with…** → Mid row (`qwen3-8b`) → `$('model')==='qwen3-8b'` and last assistant text is the new stream; user turn count unchanged.
- [ ] Bonsai row appears only when `networkModels` advertises `ternary-bonsai-2-27b`.
- [ ] Advanced child count === 0.
- [ ] After A4 edit+resend truncate, alt-model regen does not restore dropped turns.
- [ ] Esc closes the ladder; thread uncleared; still `#step-ask`.
- [ ] No Typeform `Do.` / `Start.` / `Which model?`; no `#step-model` navigation.
- [ ] Hover-only: no permanent icon rail. less-is-more + ask-chat-ux (+ v2) + quiet-shell suites stay green.

---

## 6. Fit with Ask quiet-shell

Hover-only actions. One accent (Send / Stop / active). Model stays a composer whisper plus this **on-turn** pick — never a Typeform `Start.` or door-row. Chrome budget unchanged: the ladder is a transient menu, not a second surface.

---

## 7. Stay-outs

Quill login · Muse paper faces · Instinct Phase 0 #8/#9 · Designer-publish · people-data · Potter keys · `plugin.jup.ag` · wrangler from this repo · Room People-rail · calling Second a Genie · artifacts-lite files.

---

*End. Implement on dasha-lobby after #246/#249/#255 are proven live. Cousin Continue: [ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md](ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md).*

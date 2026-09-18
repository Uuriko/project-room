# T082 — Ask Stop / Regen / Copy / Edit keyboard shortcuts brief

18 September 2026. UX keyboard brief. Docs only. Not a live Ask
HTML edit and not a dasha-lobby keydown rewrite.

**T082** — the **keyboard map** for Ask v2 hover actions:
**Stop · Regen · Copy · Edit**. Ask v2 shipped the buttons.
Quiet-shell required keyboard access. Neither named the chords.

Parents (cite only — do not rewrite):

- dasha-lobby [#249](https://github.com/Uuriko/dasha-lobby/pull/249)
  Ask chat UX v2 (A1 Stop · A2 Regen · A3 Copy · A4 Edit · A5
  Enter / Shift+Enter / Esc-back)
- [ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md) §3.4
  hover-or-focus · focus-visible ≥24px · Stop stays composer primary

Companions (cite only):
[ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md)
(T032 picker keys — ⌘K / `/` / Esc-close) ·
[ask/T033-cmdk-ready-to-implement.md](ask/T033-cmdk-ready-to-implement.md)
(T033 go/no-go) ·
[ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md](../docs/ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md)
(T042 hover Regen with…) ·
[ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md](../docs/ASK-CONTINUE-AFTER-STOP-SPEC-2026-09-18.md)
(T043 hover Continue) ·
[UX-CLEAN-LESS-NOISE-2026-09-17.md](UX-CLEAN-LESS-NOISE-2026-09-17.md)
(rank 4 hover actions). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

**Tip (source):** `Uuriko/dasha-lobby` `2e7778e6` — T073
[#275](https://github.com/Uuriko/dasha-lobby/pull/275) + Motley
[#272](https://github.com/Uuriko/dasha-lobby/pull/272). Includes
#246 / #249 / #255 quiet-shell + T030 [#270](https://github.com/Uuriko/dasha-lobby/pull/270)
hover canary. **LIVE:** still Typeform until Instinct wrangler.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

When a turn is focused, **Esc** stops, **R** regenerates, **C**
copies, **E** edits — same functions as Ask v2 hover actions. No
shortcut dump on the empty canvas. Picker keys stay T032.

---

## 1. Why this is not an overlap

| Existing spec | What it already owns | What it does **not** name |
| --- | --- | --- |
| Ask v2 [#249](https://github.com/Uuriko/dasha-lobby/pull/249) A5 | Enter send · Shift+Enter newline · Esc **back** (never nuke thread) | No chord for Stop / Regen / Copy / Edit |
| Quiet-shell v3 §3.4 | Hover **or keyboard focus**; ≥24px hit; Stop stays `#run-demo` | Which keys fire the overlay |
| T032 / T033 ⌘K | ⌘K / Ctrl+K · empty `/` · Esc **closes menu** | Explicitly **do not steal** Enter / Shift+Enter / `#run-demo` Stop |
| T042 | Hover **Regenerate with…** ladder | No `R` / no alt-model letter |
| T043 | Hover **Continue** after Stop | No Continue letter (C is Copy) |
| T075 | Picker **placement** | Not action keys |

T082 owns the **action** map. T032 owns the **picker** map. A5 stays
the **composer type** map (Enter / Shift+Enter). Three maps, one
keydown tree later — not three products.

---

## 2. Collision lock

| Parallel fold | This note does |
| --- | --- |
| Ask v2 A1–A5 ([#249](https://github.com/Uuriko/dasha-lobby/pull/249)) | **Cite only.** Same functions (`stopAskRun` · `regenerateLastAsk` · `copyAskText` · `editLastUserAsk`). Do not restyle buttons. |
| Quiet-shell §3.4 / T030 hover canary ([#270](https://github.com/Uuriko/dasha-lobby/pull/270)) | **Cite only.** Overlay stays hover-or-focus. Keys do not unhide a permanent rail. |
| T032 / T033 ⌘K / slash | **Cite only.** Do not rebind ⌘K. Do not implement `#ask-cmdk`. |
| T042 Regen with… | **Cite only.** `R` is same-model Regen. **with…** stays hover `▾` / later cmdk. |
| T043 Continue after Stop | **Cite only.** Continue stays hover. Do not steal **C**. |
| T044–T046 export / receipt / tok/s | **Cite.** Not a shortcut cheatsheet and not mid-stream copy. |
| T071–T075 ladder / placement / boundary | **Cite only.** Not this path. |
| T081 Artifacts-lite implement gate ([#521](https://github.com/Uuriko/project-room/pull/521), merge separately) | **Cite, do not rewrite.** Fence Copy is T034, not this `C`. |
| T068 / T069 battery / Prefer AC | **Not** this path. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform. No tip HTML. No wrangler. |

Paths this fold owns:

- `research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md` (this file)
- `tests/ask-keyboard-shortcuts-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` **next to
  the T042 / T043 / quiet-shell rows** (not the Artifacts-lite /
  T081 rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#275` rewrite · `#521`
Artifacts-lite rewrite.

---

## 3. Already shipped (cite, do not restyle)

Ask v2 title already teaches composer type:

> Enter to send · Shift+Enter newline · Esc back

| Chord | When | Action | Owner |
| --- | --- | --- | --- |
| **Enter** | `#prompt` focused, menu closed, not IME | Send (`#run-demo`) | A5 |
| **Shift+Enter** | `#prompt` focused | Newline | A5 |
| **Esc** | Idle, menu closed | tf-back only. **Never** clear `#ask-thread` | A5 |
| Click / Enter / Space on `#run-demo` | `askBusy` | Stop (`stopAskRun()`) | A1 |
| Hover / focus `.ask-act[data-act=copy\|regen\|edit]` | Last matching turn | Copy / Regen / Edit | A2–A4 + quiet-shell §3.4 |
| **⌘K** / **Ctrl+K** · empty **`/`** | Ask visible; not IME | Open later `#ask-cmdk` | T032 (not shipped) |
| **Esc** | `#ask-cmdk` open | Close menu; restore focus; never clear thread | T032 |

T082 adds only the **missing** action chords below.

---

## 4. Action map (T082)

Letter keys fire only when a **turn** (or its hover overlay) is
focused — never while `#prompt` is focused, never mid-IME, never
while `#ask-cmdk` is open (type-ahead / Esc-close win). Empty
`#ask-thread` has no turn, so no letters.

| Chord | When | Action | Same function as |
| --- | --- | --- | --- |
| **Esc** | `askBusy` (thinking / streaming) **and** `#ask-cmdk` closed | Stop. Same `stopAskRun()` / AbortController / keep partial / chip `stopped` | A1 `#run-demo` Stop |
| **R** | Last assistant focused; not busy; `complete` / `stopped` / `error` | Same-model Regen (`regenerateLastAsk()`). Replaces that assistant | A2 hover Regen |
| **C** | Focused assistant (or user) turn; no text selection | Copy that turn’s `.ask-said` / user text (`copyAskText()`). One-word **Copied** | A3 hover Copy |
| **⌘C** / **Ctrl+C** | Same, **and** no DOM selection | Same Copy | A3 |
| **E** | Last **user** turn focused; not busy | Edit (`editLastUserAsk()`). Fills `#prompt`; sets `askEditAt` | A4 hover Edit |

### 4.1 Stop — Esc while busy

- Composer visual primary stays **Stop**. Esc is an alias, not a
  second CTA and not a hover action.
- `#ask-cmdk` open → Esc **closes the menu** (T032). Do not Stop.
- Idle + menu closed → A5 Esc-back. Do not Stop. Do not New.
- Do **not** bind ⌘. (period) as the only Stop. Optional later Mac
  alias, never instead of Esc.
- Do **not** bind Esc on empty canvas to anything new.

### 4.2 Regen — R, not ⌘R

- **R** = A2 same-model Regen. Current `$('model')`.
- **Do not** bind ⌘R / Ctrl+R (browser refresh).
- T042 **Regenerate with…** is **not** a letter in this brief. Stay
  on the hover `▾` / later `#ask-cmdk` (`data-ask-cmdk-source="regen"`).
  Optional later: **Shift+R** when the turn is focused — not P0.
- Empty canvas: **R** does nothing (or types if `#prompt` focused).

### 4.3 Copy — C, native selection wins

- No selection → Copy the focused turn (A3 path).
- A selection inside the turn or `#prompt` → **native** copy. Do not
  override.
- T034 / T081 fence **Copy** is a different control on a collapsed
  fence. Do not rebind that here.
- T043 **Continue** must not steal **C**.

### 4.4 Edit — E on the last user

- A4 only: last user turn. **E** on an assistant turn is a no-op
  (or moves focus to the paired user — prefer no-op).
- Do not bind ⌘E.
- Edit remains the only `askEditAt` truncate trigger (T042 / T043
  already). Keys do not invent a second truncate.

### 4.5 Continue stays T043

No Continue letter. Hover / focus on the `stopped` turn still shows
**Continue**. Do not use Enter (fights Send). Do not use C (Copy).

---

## 5. Focus + discovery (quiet)

- Tab / Shift+Tab can land on a turn’s `.ask-act` cluster. Overlay
  may appear on `:focus-within` the same way it appears on hover
  (T030 canary). Keys do not paint a permanent icon rail.
- `aria-keyshortcuts` on the existing buttons (`Escape`, `r`, `c`,
  `e`). No new chrome.
- **No** shortcut cheatsheet, ⌘/ overlay, or “Keyboard shortcuts”
  modal on empty `#ask-scroll`. Empty stays `What.` + ≤4 starters
  (T047 / T075).
- Composer title may later add `Esc to stop` **while busy only**.
  Idle title stays A5 (`Enter to send · Shift+Enter newline · Esc
  back`). Do not replace A5 with a lecture.
- Focus-visible ≥24px. Touch ≥44px. Mobile: letters optional; Stop
  remains the composer primary.

---

## 6. Must not steal

- Enter-to-send / Shift+Enter newline (A5)
- ⌘K / Ctrl+K / empty `/` (T032)
- IME composition (`isComposing` / key 229)
- Browser refresh (⌘R) / copy-with-selection / find (⌘F)
- `#clear-chat` New (no letter)
- Provide / Host / Marketplace / Needle
- Typeform `#step-model` / `Start.` / `Do.` / “Which model?”

---

## 7. Existing tip canaries (cite, do not rewrite)

| Canary (tip) | Locks | Why T082 cites it |
| --- | --- | --- |
| [#249](https://github.com/Uuriko/dasha-lobby/pull/249) `dasha-compute-ask-chat-ux-v2.test.mjs` | A1–A8 Stop / Regen / Copy / Edit / Enter / Esc-back | **Functions** the keys must call |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** `dasha-compute-ask-quiet-chrome-canary.test.mjs` | Hover-only Copy / Regen / Edit; `#ask-model` whisper pill | Keys must not unhide a rail |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** `dasha-compute-ask-empty-canvas-canary.test.mjs` | Empty = `What.` + 4 starters | No shortcut dump |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) `dasha-compute-ask-quiet-shell.test.mjs` | Chrome ≤15% | No cheatsheet chrome |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** | No capacity dash | **Hands-off** |

---

## 8. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Instinct tips quiet-shell live
**and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`:

- One keydown tree: picker (T032) → busy Esc Stop → turn letters.
- Keep A5 / A1–A4 / T030 / T047 / quiet-shell + ask-chat-ux v2 green.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275. Do not combine
  with T033 or T081 Artifacts in the same lobby PR.

This repository ships the brief only.

---

## 9. Acceptance checks

- [x] T082 names Esc / R / C / E for Stop / Regen / Copy / Edit
- [x] Cites Ask v2 [#249](https://github.com/Uuriko/dasha-lobby/pull/249)
      A1–A5 and quiet-shell §3.4
- [x] States why this is not a T032 / T042 / T043 rewrite
- [x] Enter / Shift+Enter / ⌘K / empty `/` stay stolen-from-not
- [x] Continue stays T043 hover; C stays Copy
- [x] No shortcut dump on empty canvas
- [x] Quill #260 / #262 / #266 / #274 named; hands-off
- [x] dasha-lobby #275 T073 named; hands-off
- [x] #258 stays draft
- [x] T081 / #521 Artifacts-lite cited; not rewritten
- [x] No dasha-lobby HTML, no wrangler, no Worker, no people-data,
      no Designer, no Potter keys
- [x] Needle not added as Ask chrome
- [x] Second, never Genie

---

## 10. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
/ [#262](https://github.com/Uuriko/dasha-lobby/pull/262) /
[#266](https://github.com/Uuriko/dasha-lobby/pull/266) /
[#274](https://github.com/Uuriko/dasha-lobby/pull/274) compute HTML ·
Muse UI / paper faces · Instinct Phase 0 #8 / #9 · Designer-publish ·
people-data · `plugin.jup.ag` · **direct wrangler** · dasha-lobby
HTML / Worker / tests · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)
canary rewrite · T033 implement · T081 / #521 Artifacts-lite rewrite ·
T042 / T043 UX rewrite · T068 / T069 battery · listing Needle as chat ·
calling Second a Genie · `client/` `cloudflare/` `server/` `src/`
`deploy/` in this fold.

---

*End. Parents: dasha-lobby #249 Ask v2 ·
`docs/ASK-QUIET-SHELL-V3.md` §3.4.
Companion picker keys: `docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md` §5.
Companion hover Regen / Continue: T042 / T043.
Companion canaries: dasha-lobby #249 v2 · #270 T030 · #268 T047 ·
#255 quiet-shell · #275 T073 (hands-off).*

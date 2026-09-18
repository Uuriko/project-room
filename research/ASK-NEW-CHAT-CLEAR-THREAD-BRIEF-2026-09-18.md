# T084 — Ask New chat / Clear thread UX brief

18 September 2026. UX confirm brief. Docs only. Not a live Ask
HTML edit and not a dasha-lobby `clearConversation` rewrite.

**T084** — **quiet confirm** on Ask **New** / Clear thread.
Ask v2 shipped the button. It wipes on first click. This note
owns the confirm gate.

Parents (cite only — do not rewrite):

- dasha-lobby [#249](https://github.com/Uuriko/dasha-lobby/pull/249)
  Ask chat UX v2 **A7 New**: `#clear-chat` label **New**;
  `clearConversation()` clears `#ask-thread`, resets `has-chat`,
  **keeps** engine / model
- [ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md) §4
  New chat quiet top-right · §3.2 no second accent on New

Companions (cite only):
[ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md)
(T082 — `#clear-chat` has **no letter**; Esc never New) ·
[ask/T044-quiet-export-transcript.md](ask/T044-quiet-export-transcript.md)
(T044 Export is the sibling in `.ask-top`; New removes it) ·
[ask/T033-cmdk-ready-to-implement.md](ask/T033-cmdk-ready-to-implement.md)
(T033 go/no-go) ·
[UX-CLEAN-LESS-NOISE-2026-09-17.md](UX-CLEAN-LESS-NOISE-2026-09-17.md)
(New chat quiet top-right). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

**Tip (source):** `Uuriko/dasha-lobby` `2e7778e6` — T073
[#275](https://github.com/Uuriko/dasha-lobby/pull/275) + Motley
[#272](https://github.com/Uuriko/dasha-lobby/pull/272). Includes
#246 / #249 / #255 quiet-shell + T030 [#270](https://github.com/Uuriko/dasha-lobby/pull/270)
hover canary. **LIVE:** still Typeform / no bonsai until Instinct
wrangler. Instinct tipped.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

**New** on a thread with turns whispers **New chat?** then
**Clear.** Esc or Cancel keeps the thread. Never wipe without
that cancel path.

---

## 1. Why this is not an Ask v2 New rewrite

[#249](https://github.com/Uuriko/dasha-lobby/pull/249) A7 already
owns the **clear function** and the **label**. Tip today:

```
#clear-chat → clearConversation()
conversation=[]; renderConversation(); // engine / model untouched
```

One click wipes a thread that Ask cannot restore. History sidebar
is quiet-shell P1 #8 — not shipped. So New is destructive, and A7
did not name a confirm.

T082 already reserved the keys: `#clear-chat` has **no letter**;
idle Esc is tf-back; busy Esc is Stop. Neither named the confirm.

| Existing spec | What it already owns | What it does **not** name |
| --- | --- | --- |
| Ask v2 [#249](https://github.com/Uuriko/dasha-lobby/pull/249) **A7** | `#clear-chat` **New**; `clearConversation()`; keep engine / model; reset `has-chat` | Quiet confirm when turns exist |
| Ask v2 A5 | Esc **back**. Never nuke thread | Confirm / cancel on New |
| T082 | No letter for New. Esc = Stop (busy) or tf-back (idle) | The confirm face. The wipe gate |
| T032 | Esc **closes** `#ask-cmdk`; never clears thread | New confirm |
| T044 | Export sibling in `.ask-top`; gone after New | Confirm before that New |
| Quiet-shell §4 | New is quiet top-right | Confirm copy. Esc/cancel rule |
| P1 #8 History sidebar | Later restore path | Not a reason to silent-wipe today |

T084 owns the **confirm**. A7 still owns the **wipe function**
once the user confirms. T082 still owns the **keys**.

---

## 2. Collision lock

| Parallel fold | This note does |
| --- | --- |
| Ask v2 A7 ([#249](https://github.com/Uuriko/dasha-lobby/pull/249)) | **Cite only.** Same `clearConversation()`. Do not restyle New into a door. |
| T082 action keys ([#523](https://github.com/Uuriko/project-room/pull/523)) | **Cite only.** No letter for New. Esc never wipes. |
| T044 export | **Cite only.** Sibling chrome. Confirm must not steal `#ask-export`. |
| T032 / T033 ⌘K | **Cite only.** Confirm-open Esc closes confirm, same as menu-open Esc. Do not Stop. Do not wipe. |
| T042 / T043 Regen / Continue | **Cite only.** Not this path. |
| T047 empty canvas ([#268](https://github.com/Uuriko/dasha-lobby/pull/268)) | **Cite only.** Empty stays `What.` + ≤4 starters. No confirm on empty. |
| T071–T075 ladder / placement / boundary | **Cite only.** |
| T081 Artifacts-lite implement gate ([#521](https://github.com/Uuriko/project-room/pull/521)) | **Cite, do not rewrite.** |
| T083 soft-battery UX ([#524](https://github.com/Uuriko/project-room/pull/524)) | **Merge separately.** Do not rewrite that brief or the T068/T069 battery rows. |
| T068 / T069 battery / Prefer AC | **Not** this path. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma stays draft. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform / no bonsai. No tip HTML. No wrangler. |

Paths this fold owns:

- `research/ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md` (this file)
- `tests/ask-new-chat-clear-thread-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` **next to
  the T082 / quiet-shell / `#clear-chat` rows** (not the T083
  battery rows, not the T081 Artifacts-lite rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#275` rewrite · `#521`
Artifacts-lite rewrite · `#523` keyboard rewrite · `#524` battery
rewrite.

---

## 3. Already shipped (cite, do not restyle)

Ask v2 A7:

> **New** clears `#ask-thread`, resets `has-chat`, keeps engine/model

| Seam | Today | T084 change |
| --- | --- | --- |
| `#clear-chat` | Label **New**. Hidden when `!has-chat` | Keep. Confirm is additive. |
| `clearConversation()` | Immediate wipe + abort if `askBusy` | Call **only after confirm** when turns exist |
| Engine / `#ask-model` | Untouched | Stay untouched |
| A5 Esc idle | tf-back. **Never** clear thread | Stay. Esc on confirm = cancel |
| T082 Esc busy | `stopAskRun()` | Stay. Confirm-open Esc cancels confirm first |

---

## 4. Confirm map (T084)

### 4.1 When New is instant

| Surface | Confirm? | Action |
| --- | --- | --- |
| Empty Ask (`!has-chat`; `#ask-thread` hidden; `conversation.length === 0`) | **No.** | `#clear-chat` stays hidden. Click is a no-op. |
| Composer draft only (text in `#prompt`, no committed turn) | **No.** | Instant clear of the draft is allowed. No lecture. |
| Thread (`body.has-chat` **or** `conversation.length > 0`) | **Yes.** | First New does **not** wipe. |
| Mid-stream (`askBusy`) | **Yes, or disable.** | Prefer **disabled** until Stop (composer primary). If shown, same confirm — never silent abort+wipe. |

Empty canvas never grows a “New chat?” chip. T047 stays
`What.` + ≤4 starters.

### 4.2 Quiet confirm (thread has turns)

First click / Enter / Space on `#clear-chat` opens confirm.
It does **not** call `clearConversation()`.

Copy bank (whisper, same 12px muted class as **New**):

```
New chat?
Clear.
```

Allowed one-word confirm face: **Clear.** Period optional on the
question; the action is **Clear.** Not `Wipe.` · `Delete.` ·
`Start.` · `Do.` · `Are you sure you want to lose this?`

Chrome (pick one; do not add both):

- `#clear-chat` mutates: label `New chat?` + sibling `#ask-new-clear`
  (**Clear.**)
- or `#clear-chat[data-confirm=1]` with a child `.ask-new-confirm`

Not a `window.confirm()`. Not a modal. Not a Typeform step. Not a
toast stack. Acid accent stays on Send / Stop.

Hit ≥24px (touch ≥44px). `aria-expanded` on `#clear-chat` while
confirm is open.

### 4.3 Never wipe without Esc / cancel

Hard rule. If the thread has turns, wipe is unreachable unless
the confirm is showing **and** the user takes **Clear.**

| Input | Confirm open | Result |
| --- | --- | --- |
| **Esc** | Yes | Cancel. Thread uncleared. Restore **New**. Focus `#clear-chat` or `#prompt` |
| **Cancel** / outside click | Yes | Same as Esc |
| **Clear.** click / Enter on `#ask-new-clear` | Yes | Now `clearConversation()` (A7) |
| **Esc** | No, idle | A5 tf-back. **Never** New |
| **Esc** | No, `askBusy` | T082 Stop. **Never** New |
| **Esc** | Yes, and `#ask-cmdk` also open | Impossible — do not open both. Cmdk wins; New confirm stays closed |
| Letter **N** / ⌘N | — | **No bind.** T082 reserved no letter. ⌘N is a new browser window |

A first click that wipes is a bug after this brief. An Esc that
wipes is a bug. A busy New that aborts+clears without confirm is
a bug (today’s A7 `if(busy) runAbort.abort()` on the same click).

### 4.4 After confirmed Clear.

Same A7 function, gated:

1. `clearConversation()` — empty `conversation[]`, `askEditAt = -1`,
   drop `askLive`, reset `has-chat`.
2. **Keep** `$('engine')` / `$('model')` / `#ask-model`.
3. Stay on `#step-ask`. No `#step-model`. No `Start.` / `Do.`
4. Empty paint: `What.` + ≤4 starters (T047).
5. T044 `#ask-export` gone (no `has-chat`).
6. Mid-stream: if implement allowed confirm-while-busy, Stop then
   clear (keep the partial **only if** the user Stopped first via
   T082; a confirmed New may drop the live turn — that is the
   point of New — but never drop it on the first click).

Do not persist the wiped thread. History sidebar is P1 #8.

---

## 5. Must not steal

- Enter-to-send / Shift+Enter newline (A5)
- ⌘K / Ctrl+K / empty `/` (T032)
- Esc Stop while busy (T082) — unless confirm is open, then Esc
  cancels confirm first
- T044 Export
- T082 letters R / C / E
- Provide / Host / Marketplace / Needle
- Typeform `#step-model` / `Start.` / `Do.` / “Which model?”

---

## 6. Existing tip canaries (cite, do not rewrite)

| Canary (tip) | Locks | Why T084 cites it |
| --- | --- | --- |
| [#249](https://github.com/Uuriko/dasha-lobby/pull/249) `dasha-compute-ask-chat-ux-v2.test.mjs` | A7 New keeps `community` / model; clears thread | Confirm wraps that function |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** | Empty = `What.` + 4 starters | No confirm dump on empty |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** | Hover-only actions; `#ask-model` whisper | Confirm is top-right, not a rail |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) | Chrome ≤15% | No modal / lecture |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** | No capacity dash | **Hands-off** |

Live `/compute` is still Typeform. T084 does not add a live fetch
and does not wrangler.

---

## 7. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Instinct tips quiet-shell live
**and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`:

- Gate `#clear-chat` click: empty → no-op; turns → confirm; confirm
  **Clear.** → existing `clearConversation()`.
- Esc / Cancel never wipes. Keep A7 keep-engine/model.
- Keep T047 / T030 / quiet-shell + ask-chat-ux v2 green. Extend
  the v2 New test: first click with turns leaves `conversation`
  length unchanged; Esc restores **New**; **Clear.** then empties.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275. Do not combine
  with T082 keys, T083 battery, or T081 Artifacts in the same
  lobby PR.

This repository ships the brief only.

---

## 8. Acceptance checks

- [x] T084 is the Ask New chat / Clear thread **confirm** brief,
      citing Ask v2 [#249](https://github.com/Uuriko/dasha-lobby/pull/249) A7
- [x] Quiet confirm when the thread has turns (`New chat?` /
      `Clear.`)
- [x] **Never wipe without Esc/cancel** — Esc / Cancel keeps the
      thread; first New does not call `clearConversation()`
- [x] Empty canvas: no confirm chrome
- [x] Busy: New disabled or same confirm — never silent abort+wipe
- [x] A7 keep engine / model stays
- [x] T082 no-letter / Esc-never-New cited; not rewritten
- [x] T044 Export stays the sibling
- [x] Quill #260 / #262 / #266 / #274 named; hands-off
- [x] dasha-lobby #275 T073 named; hands-off
- [x] #258 stays draft
- [x] T083 / #524 named; merge separately
- [x] Live Typeform / no bonsai named; no wrangler
- [x] Index rows sit next to T082 / quiet-shell, not T083 / T081
- [x] No dasha-lobby HTML, no Worker, no people-data, no Designer,
      no Potter keys
- [x] Needle not added as Ask chrome
- [x] Second, never Genie

---

## 9. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
/ [#262](https://github.com/Uuriko/dasha-lobby/pull/262) /
[#266](https://github.com/Uuriko/dasha-lobby/pull/266) /
[#274](https://github.com/Uuriko/dasha-lobby/pull/274) compute HTML ·
Muse UI / paper faces · Instinct Phase 0 #8 / #9 · Designer-publish ·
people-data · `plugin.jup.ag` · **direct wrangler** · dasha-lobby
HTML / Worker / tests · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)
canary rewrite · T082 / [#523](https://github.com/Uuriko/project-room/pull/523)
keyboard rewrite · T083 / [#524](https://github.com/Uuriko/project-room/pull/524)
battery rewrite · T081 / #521 Artifacts-lite rewrite · T033
implement · History sidebar P1 #8 as a wipe excuse · listing Needle
as chat · calling Second a Genie · `client/` `cloudflare/` `server/`
`src/` `deploy/` in this fold.

---

*End. Parent: dasha-lobby #249 Ask v2 A7 New.
Companion keys: T082 (`#clear-chat` no letter; Esc never New).
Companion export: T044. Companion empty: T047.
Companion canaries: dasha-lobby #249 v2 · #268 T047 · #270 T030 ·
#255 quiet-shell · #275 T073 (hands-off).*

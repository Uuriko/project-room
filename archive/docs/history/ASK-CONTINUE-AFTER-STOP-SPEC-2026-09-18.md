# Ask T043 — Continue after Stop (Open WebUI steal)

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask**  
**Status:** Spec ready · implement deferred (not this repo) · docs-only  
**Plan ref:** T043 (this spec). Implement later on `Uuriko/dasha-lobby` after Instinct tips quiet-shell live.  
**Baseline tip:** dasha-lobby `#246` / `#249` / `#255` on main (live may still lag Instinct wrangler).  
**Cousins:** [ASK-QUIET-SHELL-V3.md](ASK-QUIET-SHELL-V3.md) · [ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md](ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md) · T082 action keys [ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](../research/ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md) · box `UX-CLEAN-LESS-NOISE-2026-09-17.md`

Artifacts-lite (Ask P1 panel) may land in parallel — **different path**. Do not edit those files from this fold.

Compute ≠ Project Room. No people-data, Designer-publish, `plugin.jup.ag`, Potter keys, Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) / [#9](https://github.com/Uuriko/project-room/pull/9).

---

## 0. One line

After **Stop** mid-stream, a **hover Continue** resumes the same assistant turn — append, do not duplicate the partial. Stream chrome stays **Thinking…** / **Stop**. No Typeform `Start.`

---

## 1. Problem

`#249` A1 already ships Stop: `#run-demo` becomes **Stop**, `AbortController` aborts the fetch, `commitAskLive('stopped')` **keeps the partial**, chip → `stopped`. After abort the composer primary leaves Stop (back to Send).

There is no resume. The only ways forward are **Regenerate** (throws away the partial) or a new user turn (“continue”). Both waste the tokens already on screen. Open WebUI’s Continue keeps the incomplete assistant message and asks the model to go on — Ask should steal that, quietly.

---

## 2. Steals

| Source | Take | Skip |
| --- | --- | --- |
| **Open WebUI** | Continue after stop; same message continues; partial is context, not a second bubble | Settings-heavy chrome; always-visible Continue |
| **ChatGPT** (legacy Continue generating) | Resume without retyping; Stop remains the mid-stream control | Feature-grid empty; banner “generation stopped” |
| **Ask v2 `#249`** | `stopAskRun()`, partial keep, per-turn `thinking` / `streaming` / `complete` / `stopped` / `error` | Making Continue the composer primary |
| **Ask v3 `#255`** | Visible stream word is **Thinking…**; Stop stays composer-primary while busy; hover actions | tok/s / kit / provider essay in `#ask-thread` |
| **LangGraph / quiet-shell** | Resume keeps original invocation identity in spirit (same turn); announce state without stealing focus | Auto-replay side effects; a second Send |

---

## 3. P0 UX

### 3.1 When Continue exists

- Last assistant `dataset.state === 'stopped'` **and** the user hit Stop (A1), not New / error.
- Hover or keyboard focus on **that** turn — same overlay as Copy / Regen / Edit.
- Hidden while `askBusy` (thinking / streaming). Hidden on `complete`. Hidden on `error` (use Regen). Hidden on empty canvas. Hidden on user turns.

### 3.2 Composer vs turn (do not fight v2 chrome)

| Phase | Composer `#run-demo` / `#ask-send` | Turn overlay | Visible word |
| --- | --- | --- | --- |
| Idle, no stream | Send | Copy / Regen / Edit (complete) | — |
| Mid-stream | **Stop** (A1 primary) | no Continue | **Thinking…** |
| After Stop | Send again (A1 already leaves Stop) | **Continue** + Copy + Regen (+ T042 with…) | quiet `stopped` — not a lecture |
| Continue in flight | **Stop** again | Continue hidden | **Thinking…** |
| Continue completes | Send | Copy / Regen (Continue gone) | — |

Continue is **never** a second primary CTA and **never** a Typeform `Start.` / `Do.` H1. Do not fill `#prompt` with the word “continue”.

Copy bank: `Continue` — not `Resume generation` · `Start.` · `Keep going!`.

### 3.3 Resume / append (no duplicate partial)

`continueAskRun()` (name flexible) must:

1. Re-enter `askBusy` on the **existing** last `.ask-turn.mac` — do **not** `beginAskLive` a second assistant turn.
2. State: `stopped` → `thinking` → `streaming` → `complete` (or `stopped` if Stop again).
3. POST `/compute/api/chat` with the transcript **including** the partial assistant as the last message (or the engine’s continue shape). Same `#engine` / `$('model')`.
4. Stream deltas **append** to the existing `.ask-said`. Do not clear the bubble first. Do not paint `partial` + `partial` + `rest`.
5. Markdown stays stream-safe (`renderAskMarkdown` / open fence `data-open="1"`).
6. A second Stop keeps **original + continuation** as one partial; Continue remains available.

**Empty partial** (Stop before the first token): Continue behaves like same-model Regen **inside that bubble** — one turn, no blank twin.

### 3.4 Regen vs Continue vs Edit

| Action | Transcript |
| --- | --- |
| **Continue** | Same user + same assistant bubble; append after the partial |
| **Regenerate** (A2 / T042) | Same last user; **replace** the whole assistant (partial discarded) |
| **Edit** (A4) | Fills `#prompt`; next Send truncates after that user (`askEditAt`). That Send is a new run, not Continue |

Continue does **not** set `askEditAt`. If the thread was already truncated by Edit, Continue uses that truncated prefix + the stopped partial — never resurrected tail turns.

### 3.5 Preserve IDs

`#step-ask` `#ask-input` `#ask-send` `#ask-model` `#prompt` `#run-demo` `#ask-thread` `#ask-think` `#ask-run-chip` · `stopAskRun` · `commitAskLive` · `beginAskLive` · `setAskRunChip` · `askBusy` · `runAbort`.

**Additive (implement):** `continueAskRun()` · `.ask-act[data-act=continue]`. Reuse AbortController; do not add a second stop path.

Never revive `#step-model` or Typeform `Start.`

---

## 4. Non-goals

- Changing A1 Stop / partial-keep / chip `stopped`.
- Composer-primary Continue (would fight Send / Stop).
- Auto-continue without a click.
- Continue on `error` or `complete`.
- Server-side token checkpoint / Durable Objects resume (client re-asks with the partial; good enough for P0).
- Artifacts-lite, history sidebar, follow-up chips.
- Room Second / mid-run Work Item steer.
- dasha-lobby Worker edits or wrangler from **this** PR.

---

## 5. Success tests (for the later lobby implement)

- [ ] Mid-stream: `#run-demo` is **Stop**; no Continue in the overlay; visible word **Thinking…** (or equivalent one word).
- [ ] Stop → last assistant `data-state="stopped"`; partial text still in `.ask-said`; `#run-demo` is **not** Stop.
- [ ] Hover/focus on that turn shows **Continue**. Empty canvas does not.
- [ ] Continue → same turn count (one user, one assistant); `askBusy`; chrome **Thinking…** + composer **Stop**.
- [ ] After Continue completes, `.ask-said` starts with the **exact** pre-stop partial and then new tokens — no doubled prefix.
- [ ] Second Stop mid-Continue keeps the longer partial; Continue still offered.
- [ ] Stop before first token + Continue → one assistant bubble, not two.
- [ ] `error` / `complete` turns do not show Continue.
- [ ] A4 edit+resend still truncates; Continue does not restore dropped turns.
- [ ] Esc does not clear the thread. No `Do.` / `Start.` / `#step-model`.
- [ ] Hover-only. ask-chat-ux v2 + quiet-shell suites stay green (A1 Stop / A2 Regen / A8 states).

---

## 6. Fit with Ask quiet-shell

Hover-only action on the stopped turn. Composer keeps the v2/v3 rule: **Stop while streaming, Send otherwise**. One accent. One visible stream word. Continue is a whisper on the turn that needs it — never a Typeform `Start.` or a door-row CTA.

---

## 7. Stay-outs

Quill login · Muse paper faces · Instinct Phase 0 #8/#9 · Designer-publish · people-data · Potter keys · `plugin.jup.ag` · wrangler from this repo · Room People-rail · calling Second a Genie · artifacts-lite files.

---

*End. Implement on dasha-lobby after #246/#249/#255 are proven live. Cousin alt-model Regen: [ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md](ASK-REGEN-ALT-MODEL-SPEC-2026-09-18.md).*

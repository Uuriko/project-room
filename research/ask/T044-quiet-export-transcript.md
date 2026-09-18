# T044 — Quiet export transcript (JSON / MD)

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask** (not Room)  
**Status:** Spec ready · implement deferred · docs-only  
**Plan refs:** T044 (this spec) · implement on `Uuriko/dasha-lobby` after quiet-shell tip is live  
**Companions:** [ASK-QUIET-SHELL-V3.md](../../docs/ASK-QUIET-SHELL-V3.md) · [T045](T045-receipt-collapse.md) · T087 Job whisper ([ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md](../ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md) — chip Job id; export `job_id` stays a file field) · [T046](T046-no-midstream-toks.md) · [ASK-MODEL-CMDK-SPEC-2026-09-17.md](../../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md) · T084 New confirm ([ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md](../ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md)) · T086 thread format ([ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md](../ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md) — MD download vs copy; headers / model / receipt lines)

Ask is Compute’s chat door. Compute ≠ Room. No Typeform `Start.` / `Do.` return.

---

## 0. One line

A hover-only **Export** on Ask **thread chrome** downloads the current transcript as JSON or Markdown. It never appears on the empty canvas.

---

## 1. Why

#249 already ships per-turn Copy. People also need the **whole thread** — for paste into an editor, a gist, or a later Ask — without a second product door.

Claude / ChatGPT keep export off the empty state. The thread is the object; the empty canvas is a greeting + ≤4 starters ([ASK-QUIET-SHELL-V3.md](../../docs/ASK-QUIET-SHELL-V3.md) §3.5). An Export button on “What.” would scream chrome and compete with Send.

This is **not** Room `GET /api/rooms/<id>/export` ([EXPORT-RETENTION-DELETION.md](../../docs/EXPORT-RETENTION-DELETION.md)). Room export stays Room. Ask export is a client download of `conversation[]`.

---

## 2. Where it lives

| Surface | Export? |
| --- | --- |
| Empty Ask (`body` without `has-chat`; `#ask-greet` + starters visible) | **No.** Zero export chrome. |
| Thread (`body.has-chat`; `#ask-thread` painted) | **Yes.** Quiet thread chrome only. |
| Mid-stream (`askBusy`) | Hidden or disabled. Do not snapshot a live turn as Done. |
| Typeform `#step-answer` / `#step-gate` / Provide / Pay | **No.** Ask-only. |

**Preferred chrome:** one whisper control in `#step-ask .ask-top`, same row as `#clear-chat` / New — **only when `has-chat`**. Hover/focus reveals **JSON** and **MD**. Not a permanent icon rail. Not a starter chip. New confirm (T084) must not steal this control.

**Do not** hang Export on every `.ask-turn`. Per-turn Copy already covers one bubble ([#249](https://github.com/Uuriko/dasha-lobby/pull/249) A3).

---

## 3. Preserve IDs / seams

| ID / seam | Role |
| --- | --- |
| `#step-ask` | Ask surface. Stay here. |
| `#ask-thread` | Turns. Source of painted transcript. |
| `#ask-composer` / `#ask-input` / `#prompt` | Composer. Untouched. |
| `#ask-send` / `#run-demo` | Send / Stop. Untouched. |
| `#ask-model` | Whisper model pill. Untouched. |
| `#clear-chat` | New. Sibling, not a child of Export. |
| `conversation[]` | Canonical turns. Export reads this, not the Typeform answer pane. |
| `body.has-chat` | Gate. No export without it. |

**Additive IDs (implement):** `#ask-export` (chrome root), `#ask-export-json`, `#ask-export-md`, or hover children `.ask-act[data-act=export-json|export-md]`.

**Never revive:** `#step-model`, Typeform `Start.` / `Do.` H1s, door-row first paint.

---

## 4. Payloads

Client-side `Blob` + download. No new Worker route. No persist. No Room event.

### JSON

```json
{
  "kind": "dasha.ask.transcript.v1",
  "exportedAt": "ISO-8601",
  "engine": "hosted|community|mixture|self",
  "model": "string|UNKNOWN",
  "job_id": "string|null",
  "turns": [
    { "role": "user|assistant", "content": "string", "state": "complete|stopped|error" }
  ]
}
```

- `turns` = completed (or stopped/error) entries from `conversation[]`. Drop live `askLive` unless the user stopped and the partial was committed.
- `model` / `engine` copy the live select, or `UNKNOWN`.
- `job_id` from `lastPaidReceipt` when present; else `null`.
- **No** session tokens, API keys, emails, X handles, wallet addresses, people-data.
- **No** invented tok/s. Measured speed belongs on the receipt ([T045](T045-receipt-collapse.md)), not as a guessed export field. If a later implement adds `tokens_per_second`, it is `UNKNOWN` unless Compute measured it.

Filename: `ask-transcript-YYYYMMDD.json`.

### Markdown

Readable thread:

```md
# Ask transcript
- Engine: community
- Model: ternary-bonsai-2-27b
- Exported: 2026-09-18T…

## You
…

## Mac
…
```

- Speaker labels match the thread (`You` / `Mac` / Hosted face) — not Room member names.
- Fence assistant markdown as-is. Do not re-render HTML.
- Filename: `ask-transcript-YYYYMMDD.md`.

One-word confirmation on the control: **Copied** is for per-turn Copy. Export may flash **Saved** (or the browser download UI). No toast stack. No honesty lecture. Format bank (which header / model / receipt lines ship): [T086](../ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md).

---

## 5. Quiet-shell fit

- Hover-or-focus only on fine pointers; touch keeps the control visible (same rule as [QUIET-FAST.md](../../docs/QUIET-FAST.md) message extras).
- Hit targets ≥24px (touch ≥44px). Keyboard: focus `#ask-export`, Enter opens JSON/MD choice; Esc closes; never clears the thread.
- One accent (acid) stays on Send / Stop. Export is muted paper.
- Chrome budget still ≤15%. Export must not add a second primary CTA.

---

## 6. Acceptance

### Must

- [ ] `#ask-export` (or equivalent) absent when `body` has no `has-chat`.
- [ ] Present after the first committed turn; hidden again after **New** (`#clear-chat`).
- [ ] JSON + MD both download; JSON `kind` is `dasha.ask.transcript.v1`.
- [ ] No keys, emails, wallets, or people-data in either file.
- [ ] No Typeform `Start.` / `Do.` chrome; stay on `#step-ask`.
- [ ] `#step-ask` `#ask-input` `#ask-send` `#ask-model` `#ask-composer` preserved.
- [ ] less-is-more + ask-chat-ux (+ v2) suites stay green.

### Must not

- [ ] Empty-canvas Export / starter-chip Export.
- [ ] Room export route or Room receipt schema.
- [ ] Mid-stream tok/s essay in the file or the button label ([T046](T046-no-midstream-toks.md)).
- [ ] Quill / Muse / Phase 0 #8/#9 / Designer-publish / `plugin.jup.ag` / people-data / direct wrangler / dasha-lobby Worker in **this** repo.

---

## 7. Test sketch (dasha-lobby implement)

- Empty first paint: no `#ask-export`.
- After one user+assistant complete: control exists; JSON has 2 turns; MD has both speakers.
- **New** removes the control.
- `askBusy`: export hidden/disabled.
- Secret scan: fixture conversation with a fake key string is **not** auto-included from anywhere except turn text the user typed (do not inject session).

---

## 8. Stay-outs

Artifacts-lite (T034) · Regen / Continue (T042 / T043) · Bonsai RAM (T060 / T065) · ⌘K model menu (T032 / T033) · Room `room.receipt.v1` · Compute Start blob · Needle as Ask chat · calling Second a Genie.

*End. Parent: Ask quiet-shell v3 hover actions + empty-state cap.*

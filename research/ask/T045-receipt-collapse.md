# T045 — Receipt collapse after complete

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask** (not Room)  
**Status:** Spec ready · implement deferred · docs-only  
**Plan refs:** T045 (this spec) · implement on `Uuriko/dasha-lobby` after quiet-shell tip is live  
**Companions:** [ASK-QUIET-SHELL-V3.md](../../docs/ASK-QUIET-SHELL-V3.md) · [T044](T044-quiet-export-transcript.md) · T086 export format ([ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md](../ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md) — Job line only when `lastPaidReceipt` has an id; tok/s stays on this chip) · T087 Job whisper ([ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md](../ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md) — `#ask-receipt` shows Job id only on expand when `lastPaidReceipt` has one; never a capacity dash) · [T046](T046-no-midstream-toks.md) · [BRIDGE-COMPUTE.md](../../docs/BRIDGE-COMPUTE.md)

Ask is Compute’s chat door. Compute ≠ Room. Honesty stays short. No Typeform `Start.` return.

---

## 0. One line

When a turn **completes**, the honesty receipt **folds** to one quiet line. Hover or focus expands it. Mid-stream it does not exist.

---

## 1. Why

Quiet-shell rule: streaming status is **one word** (“Thinking…” / Stop). Receipts are evidence, not a lecture ([UX-CLEAN-LESS-NOISE-2026-09-17.md](../UX-CLEAN-LESS-NOISE-2026-09-17.md) rank 6; [FOLD-COMPUTE-ROOM.md](../../docs/FOLD-COMPUTE-ROOM.md) “Short copy. No disclaimer lectures.”).

On tip `dasha-compute.html`:

- `#ask-receipt` is painted by `paintAnswerReceipt()` after a paid/community completion.
- `#step-ask #ask-receipt` is **`display:none !important`**. The quiet shell hid the Typeform receipt dump — correct subtraction, but it also hid honesty entirely.
- `#rcpt` / `#answer-receipt` still write a paragraph (`who ran N tokens for $x. Chained to the public receipt log.`) plus **Raw receipt** JSON. That is Answer-step density, not Ask thread chrome.

T045 puts honesty back **on the thread**, then immediately folds it.

This is **not** `room.receipt.v1` ([ROOM-RECEIPT-V1.md](../../docs/ROOM-RECEIPT-V1.md)). Compute jobs are not Room receipts. A Compute honesty receipt may correlate to a Work Item later; it does not satisfy that schema.

---

## 2. When it appears

| Turn state | Receipt chrome |
| --- | --- |
| `thinking` / `streaming` / `queued` | **None.** No tok/s, no job id, no settle lecture ([T046](T046-no-midstream-toks.md)). |
| `complete` / `stopped` / `error` | Folded chip. Expand on hover/focus. |
| Empty canvas / no `lastPaidReceipt` | **None.** Do not invent a receipt. |
| Hosted with no measured Mac tok/s | Folded chip allowed; tok/s field is `UNKNOWN` (never a Hosted boast). |

**Placement:** after the last assistant turn, still inside `#ask-thread` (or a single sibling under `#ask-scroll` that only paints when `has-chat`). Not in the empty greet. Not a second primary CTA.

---

## 3. Folded vs expanded

### Folded (default after complete)

One muted line. Examples — pick the **shortest true** face:

```
Receipt
Community · 13.5 tok/s
Hosted · UNKNOWN
Stopped
Honesty UNKNOWN
```

Rules:

- tok/s **only** when Compute measured it (`capacity.measured_providers ≥ 1` or receipt field). Else omit the number or write `UNKNOWN`. Never invent ([BRIDGE-COMPUTE.md](../../docs/BRIDGE-COMPUTE.md)).
- Settled cents **only** when paid and Compute reported settle. Pending is not a guessed `$`.
- No kit version. No provider essay. No “Chained to the public receipt log.”
- Acid accent stays off this chip (acid = Send / Stop only).

### Expanded (hover, focus, or click-toggle)

Same honesty fields as the bridge, short:

| Field | Rule |
| --- | --- |
| Model id | Copied when known; else `UNKNOWN`. |
| Class | `hosted` / `community` / `mixture` / `self` as Compute reported. |
| tok/s | Measured only; else `UNKNOWN`. |
| Tokens | Completion count if reported; else omit. |
| Settled | Cents if paid+settled; else `pending` / omit. |
| Job id | Exact run reference; may link `/verify?hash=` when a hash exists. |

Optional `<details>` **Raw** for the JSON object already on `#rcpt-raw`. Default closed. Not a wall of JSON on first expand.

Esc or mouseleave returns to folded. Keyboard: focus chip → Enter expands; Esc folds; never clears the thread.

Touch: tap toggles (no hover). Hit target ≥44px.

---

## 4. Preserve IDs / seams

| ID / seam | Role |
| --- | --- |
| `#ask-receipt` | Keep. Remove the `#step-ask #ask-receipt { display:none !important }` hide **or** replace it with a collapsed face. Do not delete the node. |
| `#ask-mac-line` | Stay hidden on Ask unless the expanded receipt needs a single Mac name. No extra strip. |
| `#ask-run-chip` | Done flash only. Not the receipt. |
| `#ask-think` | Stream word only. Never a receipt. |
| `lastPaidReceipt` / `honestyFieldsFrom` | Source of truth. Do not re-measure in the client. |
| `#rcpt` / `#answer-receipt` | Typeform Answer leftovers. Do not restyle them into Ask. Do not auto-`showTf('answer')`. |

**Additive:** `#ask-receipt[data-fold=collapsed|expanded]`, or a child `#ask-receipt-face` + `#ask-receipt-detail`.

`stayAskChat` remains true. Completing a run must not bounce to `#step-answer`.

---

## 5. Honesty copy bank (short)

Allowed:

> Receipt in. model id · community · tok/s if measured · settled cents if paid.  
> Honesty UNKNOWN. No invented speed.  
> Mac offline. Still queued. *(stream/blocked — not a receipt)*

Forbidden on Ask:

- Disclaimer blocks / “by using this you agree”
- Kit version / llama.cpp / Ollama essays
- Mid-stream `13.5 tok/s` inside `.ask-said` or `#ask-think`
- Invented Community boast when `providers_online` is pending/null
- People-data, wallet dumps, Potter keys

---

## 6. Acceptance

### Must

- [ ] No `#ask-receipt` text while `askBusy` / `thinking` / `streaming`.
- [ ] After `complete`, receipt is folded to one line; hover/focus/tap expands.
- [ ] Unmeasured tok/s is `UNKNOWN` or omitted — never a guessed number.
- [ ] Hosted never borrows Mac tok/s (tip comment already says this; keep it).
- [ ] `#step-ask` stays the surface; no `showTf('answer')` on complete.
- [ ] `#ask-receipt` node id preserved (tests may already pin it).
- [ ] Reduced motion: no tok/s digit pop on the chip (`paintTopTpsPop` stays off Ask thread).

### Must not

- [ ] Permanent Typeform receipt paragraph under the thread.
- [ ] Room `room.receipt.v1` fields (`workItemId`, personas, `peopleData`, Cua fleet).
- [ ] Empty-canvas receipt.
- [ ] Quill / Muse / Phase 0 #8/#9 / Designer / `plugin.jup.ag` / people-data / wrangler / Worker in **this** repo.

---

## 7. Test sketch (dasha-lobby implement)

- Stream fixture: `#ask-receipt` empty/hidden while deltas arrive.
- Complete + measured community tps: folded face contains `tok/s` **once**; expanded shows model + class.
- Complete + no measurement: face is `Receipt` or `Honesty UNKNOWN`; no `\d+(\.\d+)? tok/s`.
- Hosted complete: no Mac tok/s string.
- Hover/focus-within expands; blur folds.
- `showTf` not called with `answer` when `stayAskChat`.

---

## 8. Stay-outs

T044 export chrome · T086 export format (header / Job lines; not this chip) · T087 Job whisper (when `#ask-receipt` shows Job id; chip ≠ capacity dash) · T046 mid-stream lint · T034 Artifacts-lite · T042 / T043 Regen / Continue · T060 / T065 Bonsai RAM · `#honesty-panel` network strip (Compute P1 — T072: [ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](../ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md)) · Room Done chip.

*End. Parent: quiet-shell “one word” stream + honesty after the fact.*

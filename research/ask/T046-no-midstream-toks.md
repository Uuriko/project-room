# T046 — No mid-stream tok/s essay

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask** stream UI  
**Status:** Spec ready · lint/test rule · docs-only  
**Plan refs:** T046 (this spec) · implement test + paint guard on `Uuriko/dasha-lobby`  
**Companions:** [ASK-QUIET-SHELL-V3.md](../../docs/ASK-QUIET-SHELL-V3.md) §3.6 · [T045](T045-receipt-collapse.md) · [T044](T044-quiet-export-transcript.md) · [HONEST-EMPTY.md](../../docs/HONEST-EMPTY.md)

Ask is Compute’s chat door. Compute ≠ Room. Stream chrome is one word. No Typeform `Start.` lecture.

---

## 0. One line

While a reply is streaming, the Ask UI never paints a tokens/sec essay. A lint/test rule locks that.

---

## 1. Why

Quiet-shell P0: **“Thinking…” / Stop.** No tok/s, kit version, or provider essay mid-stream ([ASK-QUIET-SHELL-V3.md](../../docs/ASK-QUIET-SHELL-V3.md) §3.6; [UX-CLEAN-LESS-NOISE-2026-09-17.md](../UX-CLEAN-LESS-NOISE-2026-09-17.md) anti-noise).

Tip today already knows the honesty rule for **numbers** (`measured_providers ≥ 1`; never invent). It still **paints** tok/s in many live faces (`#top-state`, engine titles, `paintTopTpsPop` digit animation, Community chip `aria-label`). Those faces must not leak into the **streaming turn**.

A mid-reply “13.5 tok/s · llama.cpp · community Mac · kit 0.3.1” is a lecture. It steals the thread, invents confidence, and breaks the one-word contract even when the number is real.

T045 may show measured tok/s **after complete**, folded. T032’s ⌘K menu may show a soft measured tok/s on a **closed** model row. Neither is mid-stream.

---

## 2. Forbidden while streaming

`askBusy === true` **or** live turn `state` ∈ `thinking` | `streaming` | `queued`.

These nodes must not contain a tok/s lecture:

| Node | Allowed visible copy |
| --- | --- |
| `#ask-think` | `Queued…` / `Hosted…` / `Mac…` / empty. **Not** “Thinking at 13.5 tok/s”. |
| `#ask-run-chip` | `spin` / `stopped` / `error` titles: Running / Stopped / Error. No tps. |
| `#run-demo` / `#ask-send` | **Stop**. No speed subtitle. |
| `.ask-turn[data-live] .ask-said` | Model tokens only (the reply). |
| `.ask-turn[data-live] .ask-who` | Speaker. No `· 13.5 tok/s`. |
| `#ask-receipt` / `#ask-mac-line` | Hidden / empty ([T045](T045-receipt-collapse.md)). |
| `#ask-hint` | Hidden. |

**Lecture** means any of:

- `\d+(\.\d+)?\s*tok(?:ens)?/?s`
- `tokens per second` / `tokens/sec` / `t/s` as a speed claim
- Kit / runtime essays: `llama.cpp`, `llama-server`, `Ollama`, `kit 0.` **as stream status**
- Provider capacity essays: `N Macs online · measured…` **inside the turn**
- Disclaimer blocks (`by using`, `you agree`, multi-sentence honesty)

SSE `usage` / `receipt` / `settle` payloads may **arrive** mid-stream. Buffer them on `lastSseUsage` / `lastSseReceipt` as tip already does. **Do not paint** them until `commitAskLive('complete'|'stopped'|'error')`.

---

## 3. Allowed after complete (not this rule’s reject)

- Folded `#ask-receipt` face with measured tok/s ([T045](T045-receipt-collapse.md)).
- ⌘K / `#ask-model` menu row, **menu closed over composer**, measured only ([ASK-MODEL-CMDK-SPEC-2026-09-17.md](../../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md) §4).
- `#honesty-panel` / `#top-state` network strip — **Compute chrome**, not the streaming bubble. Prefer it stay off `#step-ask` first paint (quiet-shell ≤15%). If `#top-state` remains in the header, it is out of the **turn** lint but must still be measured-only / never-invent.

T046’s hard fail is the **thread + composer stream faces**, not the whole document.

---

## 4. Lint / test rule (implement on dasha-lobby)

New test file (suggested): `dasha-compute-ask-no-midstream-toks.test.mjs`.

### 4.1 DOM / stream fixture

1. Mount Ask (`#step-ask` visible, `stayAskChat`).
2. Start a run; feed SSE deltas that **include** `usage.tokens_per_second` / a fake `13.5` / `llama.cpp`.
3. While `askBusy`:

```
assert.doesNotMatch($('ask-think').textContent, TOK_RE)
assert.doesNotMatch($('ask-run-chip').title, TOK_RE)
assert.doesNotMatch(liveSaid.textContent, TOK_RE)
assert.doesNotMatch(liveWho.textContent, TOK_RE)
assert.ok($('ask-receipt').hidden || !$('ask-receipt').textContent)
```

4. After complete: T045 may put a **single** measured `tok/s` on the folded receipt. The **assistant `.ask-said`** still must not grow a speed essay the model did not write.

`TOK_RE` (pin this):

```js
/\b\d+(\.\d+)?\s*tok(?:ens)?\/?s\b|\btokens per second\b|\btokens\/sec\b/i
```

Kit essay (stream faces only):

```js
/\b(llama\.cpp|llama-server|ollama|kit\s*0\.)\b/i
```

### 4.2 Source lint (optional companion)

Scan `paintAskStreamDelta` / `setAskThink` / `paintAskLiveTurn` / `fillAskSaid(..., streaming=true)` for string literals matching `TOK_RE`. Capacity painters (`paintTopTpsPop`, `fleetMeasuredLabel`) stay allowed **if** they do not write into the nodes in §2.

Do **not** ban `tok/s` from Provide / network tables. Those are not Ask stream UI.

### 4.3 Suites that must stay green

`dasha-compute-ask-chat-ux` (+ v2) · less-is-more · honesty-panel (measured-only) · presence / buyer-live-models.

A test that **requires** mid-stream tok/s in `#ask-think` or `.ask-said` is stale; retire it the way Start-gate leftover pins were retired.

---

## 5. Preserve IDs / stream contracts

| ID / seam | Role |
| --- | --- |
| `#ask-think` | One-word status. |
| `#ask-run-chip` | spin / check / stopped / error. |
| `#ask-send` / `#run-demo` | Stop while busy. |
| `askLive` / `commitAskLive` | State machine from #249 A8. |
| `paintAskStreamDelta` | Tokens of the **reply**, not telemetry. |
| `AbortController` / partial keep | Unchanged. |

No new Typeform step. No `#step-model`. No wrangler from this repo.

---

## 6. Acceptance

### Must

- [ ] Stream fixture with injected tps/kit fields paints **none** of that into §2 nodes.
- [ ] Visible stream copy is one word / Stop.
- [ ] Receipt tok/s, if any, only after complete and folded ([T045](T045-receipt-collapse.md)).
- [ ] Unmeasured speed never becomes a number (`UNKNOWN` or omit).
- [ ] `#step-ask` `#ask-input` `#ask-send` `#ask-model` preserved.

### Must not

- [ ] Mid-stream tok/s lecture as “honesty”.
- [ ] Invented Community speed when network is pending/null ([#257](https://github.com/Uuriko/dasha-lobby/pull/257) SSR Mac pending).
- [ ] Quill / Muse / Phase 0 #8/#9 / Designer / `plugin.jup.ag` / people-data / Potter keys / dasha-lobby Worker edit in **this** repo.

---

## 7. Stay-outs

T044 export · T045 folded receipt face · T034 Artifacts-lite · T042 / T043 Regen / Continue · T032 / T033 ⌘K menu · T060 / T065 Bonsai RAM notes · Provide earn receipt · Room traces.

*End. Parent: quiet-shell “Streaming status one word.”*

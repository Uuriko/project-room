# Ask ⌘K / slash model menu — Dasha Compute Ask (getdasha)

**Date:** 2026-09-17 ~6:10 PM PT  
**Product:** getdasha.com/compute **Ask**  
**Status:** Spec ready · implement deferred (not small) · docs-only ship first  
**Baseline tip:** `Uuriko/dasha-lobby` `b5fd6e1c` (#257 SSR Mac pending until network known) atop #255 quiet-shell + #246/#249  
**LIVE:** still clobbered (Typeform) until Instinct wrangler — **still ship on tip**  
**Companions:** box `UX-CLEAN-LESS-NOISE-2026-09-17.md` · `docs/ASK-QUIET-SHELL-V3.md` · box `GEMMA27-DEMOTE-AFTER-BONSAI.md` (dasha-lobby #258 draft)  
**Plan refs:** T032 (this spec) · T033 (implement PR after tip live) · T071 (Speed/Mid/Quality ladder — [ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](../research/ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md)) · T075 (picker placement — [ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md](../research/ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md))

Mirror on box: `/workspace/phase0-publish/ASK-MODEL-CMDK-SPEC-2026-09-17.md`

---

## 0. One line

`#ask-model` stays a **whisper pill**. Click, **⌘K** / **Ctrl+K**, or **`/`** in an empty composer opens a Raycast-style model list — never a Typeform “Which model?” step.

---

## 1. Why (noise diet)

UX-CLEAN rank **4**: model as whisper pill, not scream picker. Raycast steal: ⌘K / `/` switch; Speed · Mid · Quality face labels; raw ids under Advanced. Claude: model tucked in composer bar.

Today on tip (`paintAskModel`): `#ask-model` is a native `<select class="ask-model-pill">` shown only for Community / mixture / self engines; **no** `metaKey` / cmdk / slash handler. This spec defines the menu that replaces native-select scream without losing the pill ID.

---

## 2. Preserve IDs / seams (do not break)

| ID / seam | Role |
| --- | --- |
| `#step-ask` | Ask step root |
| `#ask-input` | Composer field label / input seam (wraps `#prompt`) |
| `#ask-send` | Actions cluster housing `#run-demo` (Send ↔ Stop) |
| `#ask-model` | Whisper model pill — **primary trigger + selected value owner** |
| `#ask-composer` | Sticky composer shell (add `id="ask-composer"` if only class exists on tip) |
| `#prompt` | Textarea — slash gate reads emptiness here |
| `#run-demo` | Primary send / Stop |
| `#change-engine` / `#engine` | Hosted / Community / My Mac |
| `#model` | Hidden/canonical model value synced from pill |
| `MODELS[]` | Canonical allowlist — **must keep** `ternary-bonsai-2-27b` |
| `paintAskModel` / `askModelPool` / `$('model')` sync | Engine + network pool remain source of truth |

**Optional additive IDs (implement):** `#ask-cmdk` (palette root), `#ask-cmdk-list`, `#ask-cmdk-filter`, `[data-ask-cmdk-item]`, `.ask-cmdk-group`, `.ask-cmdk-advanced`.

**Never revive:** `#step-model` wizard / Typeform “Which model?”.

---

## 3. Current MODELS (tip `b5fd6e1c`) — do not drop Bonsai

Exact tip tuples (`dasha-compute-page.mjs` / embedded HTML):

```
qwen3-4b              Qwen 3 4B              2.5 GB   fast chat
qwen3-8b              Qwen 3 8B              5.2 GB   fast chat
gemma3-12b            Gemma 3 12B            8.1 GB   vision + chat
gpt-oss-20b           GPT-OSS 20B            14 GB    reasoning + tools   (Hosted floor)
qwen3-30b-a3b         Qwen 3 30B A3B         19 GB    efficient MoE
gemma3-27b            Gemma 3 27B            17 GB    large multimodal
ternary-bonsai-2-27b  Ternary Bonsai 2 27B   PQ2      community           ← KEEP
```

**Hard rule:** `ternary-bonsai-2-27b` stays in `MODELS` and remains selectable when the network advertises it. Never invent Bonsai when offline.

**Collision lock with #258:** gemma3-27b demote is a **separate gated draft** (`grok/gemma27-demote-after-bonsai`). This cmdk work must **not** hide/move gemma3-27b. Leave an **empty Advanced** group ready for that later demote — do not populate Advanced with gemma in the cmdk PR.

---

## 4. Speed / Mid / Quality face labels

Face labels on **primary** rows (not raw GB essays). Soft measured tok/s only when network stamped.

| Ladder | Face | Model ids (default mapping) | Notes |
| --- | --- | --- | --- |
| **Speed** | Speed | `qwen3-4b` | Fast chat; SUB24 |
| **Mid** | Mid | `qwen3-8b`, `gemma3-12b` | Default community ladder |
| **Quality** | Quality | `ternary-bonsai-2-27b` when advertised | Bonsai is Quality when live |
| Hosted floor | Hosted | `gpt-oss-20b` | Unchanged |
| MoE / large | (when advertised) | `qwen3-30b-a3b` | Not a face ladder hero |
| **Advanced** | Advanced | **empty in this ship** | Placeholder group header only — gemma3-27b moves here later via #258, not here |

Row layout (Raycast-ish):

```
Quality
  Ternary Bonsai 2 27B     13.5 tok/s   ← soft, measured only
  ternary-bonsai-2-27b                ← muted raw id subtitle OR title
Mid
  Qwen 3 8B
  Gemma 3 12B
Speed
  Qwen 3 4B
Advanced                               ← empty (no children) until #258
```

Copy bank: `Speed` · `Mid` · `Quality` · `Advanced` · `Hosted` · `Community` · `My Mac` — no “Which model?”.

---

## 5. Keyboard map

| Chord / key | When | Action |
| --- | --- | --- |
| **⌘K** (mac) / **Ctrl+K** (win/linux) | Ask step visible; not mid IME | Open `#ask-cmdk` model list; focus filter |
| **/** | `#prompt` focused **and** value is empty (no leading text) | Open same list; prevent inserting `/` |
| **/** | `#prompt` has any text | Insert `/` normally (paths, regex, prose) |
| Click / Enter / Space on `#ask-model` | Pill visible | Open same list (replace native select UX) |
| **↑ / ↓** | Menu open | Move highlight |
| **Enter** | Menu open + highlight | Select model; sync `#ask-model` + `$('model')`; close; return focus `#prompt` |
| **Esc** | Menu open | Close; restore focus to previous (`#prompt` or `#ask-model`) — **never** clear thread |
| **Esc** | Menu closed | Existing Ask Esc behavior (tf-back only; never clear thread) |
| Type-ahead | Menu open | Filter rows by face label + raw id |
| **Tab** | Menu open | Stay-in-list cycle (prefer) or close — pick one in implement |

**Do not steal:** Enter-to-send on `#prompt` when menu closed; Shift+Enter newline; Stop on `#run-demo` while streaming.

**Hosted engine:** if `#ask-model` is hidden (`paintAskModel` non-mac path), ⌘K may still open a **Hosted-only** one-row list (`gpt-oss-20b`) or no-op with no toast — prefer open Hosted-only list for consistency.

---

## 6. Interaction / a11y

- Pill remains quiet: no border scream; hover → paper; max-width ~11rem (tip CSS).
- Menu: portal/fixed near composer; prefer no dim backdrop (less noise); Esc + outside click close.
- `role="listbox"` + `aria-activedescendant` (or combobox pattern); pill `aria-expanded`.
- Mobile: full-width sheet from composer; same IDs; touch targets ≥44px.
- Selecting a model must call the same path as today’s `#ask-model` `change` → `$('model').value` → `updateRun()`.

---

## 7. Acceptance criteria

### Must

- [ ] `#step-ask` `#ask-input` `#ask-send` `#ask-model` `#ask-composer` preserved (composer id added if missing).
- [ ] ⌘K / Ctrl+K opens model list from Ask without leaving `#step-ask`.
- [ ] `/` opens list **only** when `#prompt` is empty; otherwise types `/`.
- [ ] Clicking `#ask-model` opens the same list (native select not required to stay visible — value still on `#ask-model` or mirrored).
- [ ] `ternary-bonsai-2-27b` remains in `MODELS` and appears when network advertises it.
- [ ] Speed / Mid / Quality labels on primary groups; no GB/tok essays in default rows.
- [ ] **Advanced** group exists and is **empty** (no gemma3-27b move in this PR).
- [ ] Esc closes menu; thread uncleared.
- [ ] No navigation to `#step-model` / Typeform model step.
- [ ] No collision with #258 demote branch / draft PR body.
- [ ] less-is-more + ask-chat-ux (+ v2) honesty suites stay green.

### Must not

- [ ] Quill / Muse / Phase 0 / Designer-publish / people-data / plugin.jup.ag / direct wrangler.
- [ ] Provide / Host / Marketplace inside the model menu.
- [ ] Needle listed as an Ask model.
- [ ] Mid-stream tok/s essay in the menu or thread.

---

## 8. Implement sizing — why docs-first

Touch surface on tip: embedded `COMPUTE_PAGE_HTML` in `dasha-compute-page.mjs` (~260KB one-liner) + `paintAskModel` + global keydown + tests. Raycast list + filter + ladder groups + a11y is **not** a small safe PR while LIVE is Typeform-clobbered and #258 owns gemma demote.

**Ship path:**

1. **This doc** → box `/workspace/phase0-publish/ASK-MODEL-CMDK-SPEC-2026-09-17.md` + docs-only PR on `Uuriko/project-room` `docs/` (this file).
2. **T033 implement** on `Uuriko/dasha-lobby` after Instinct tips quiet-shell live markers — CloudAgent preferred when available; keep Advanced empty; do not touch #258.

CloudAgent was **N/A** in this executor session (no LaunchCloudAgent tool); docs PR opened via GitHub MCP as Uuriko.

---

## 9. Stay-outs

| Lane | Rule |
| --- | --- |
| Quill | No login / Room Quill trees |
| Muse | No Muse paper / home Webflow |
| Phase 0 | No Instinct Phase 0 #8/#9 source |
| Designer | No Designer-publish |
| plugin.jup.ag | No |
| people-data | No |
| wrangler | Tip Instinct only — no direct wrangler |
| #258 gemma demote | Separate gated draft — empty Advanced only here |

---

## 10. Test sketch (for T033)

- Unit/DOM: empty `#prompt` + `/` → `#ask-cmdk` open; non-empty + `/` → slash inserted.
- ⌘K opens; Esc closes; focus returns.
- Select Bonsai when `networkModels` has it → `$('model').value === 'ternary-bonsai-2-27b'`.
- Advanced child count === 0.
- MODELS still includes bonsai + gemma3-27b (demote not this PR).
- Regression: Enter send / Stop abort / hover actions unchanged.

---

*End. Cousin: `docs/ASK-QUIET-SHELL-V3.md` §3.3 quiet model chip.*

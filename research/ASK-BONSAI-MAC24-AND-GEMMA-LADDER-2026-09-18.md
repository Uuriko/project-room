# T060 + T065 — Bonsai 24GB soft limit + vs gemma3-27b Ask ladder

18 September 2026. Combined research note. Docs only. Not a live
Provide lecture and not a dasha-lobby picker rewrite.

**T060** — Mac ~24GB RAM is a **soft** floor next to Ternary Bonsai 2
27B Community Provide. Swap risk. Prefer 8B / 12B for interactive.
**T065** — one-pager: Bonsai vs `gemma3-27b` for the Ask ladder
(speed / quality / RAM) and **when** to demote gemma after Bonsai is
live.

Fold lock: [FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md). Ask
quiet-shell: [ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md).
⌘K picker spec (T032, do not restyle here):
[ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md).
Needle is **not** an Ask chat model:
[ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md](../docs/ROOM-NEEDLE-CONFIDENCE-TRIGGERS-V0.md).

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door.

---

## 0. One line

Serve Ternary Bonsai 2 27B on a ~24GB Mac only with the speed
profile; keep 8B / 12B as the interactive Provide default; make
Bonsai the Ask **Quality** rung and demote `gemma3-27b` only after
Bonsai stays advertised — implement that demote on dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258), not here.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| Artifacts-lite | **Not** this path. No artifacts panel, export, or thread-side files. |
| T042 / T043 Ask regen + Continue specs | **Not** this path. No `#ask-*` chrome, regen, or Continue contract. |
| T044–T046 export / receipt / tok/s specs | **Not** this path. No receipt writer, export, or live tok/s essay. |
| T032 ⌘K / slash model menu | Cite only. Do not restyle `#ask-model` or fill Advanced. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit.** That draft owns the live demote. |
| dasha-lobby [#248](https://github.com/Uuriko/dasha-lobby/pull/248) | Already merged allowlist. Instinct tip is not this PR. |

Paths this fold owns:

- `research/ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md` (this file)
- index rows on `research/README.md` and `docs/README.md`

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag`.

---

## 2. T060 — Mac ~24GB RAM soft limit (Community Provide)

### 2.1 What “soft” means

~24GB unified memory is the **practical floor** for a Community Mac
that advertises `ternary-bonsai-2-27b`. It is **not**:

- a doctor hard-fail
- an attestation claim
- lecture copy on live `/compute` Provide
- a reason to unlist Bonsai from `MODELS`

Live Provide already soft-warns (battery / Low Power / thermal / SIP)
and never fails solely on those. RAM stays in the same class: warn in
operator docs, do not block Register → Setup, do not add a disclaimer
block to the live site.

### 2.2 Why 24GB still matters (weights fit; the rest does not)

Vendor pack
([prism-ml/Ternary-Bonsai-2-27B-gguf](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf)):
PQ2_0 is **7.21 GB** on disk (2.13 bits/weight). That **does** fit in
24GB. Swap risk is the **working set**, not the GGUF:

| Resident | Why it grows |
| --- | --- |
| PQ2_0 weights | ~7.2 GB (fits) |
| KV cache | Grows with context. 8k is the measured profile; long ctx is the swap path |
| mmproj / vision tower | Extra pack if left on GPU / unified Metal |
| Thinking / reasoning | Extra decode + KV if left on |
| Parallel slots (`-np`) | Each slot is another KV working set |
| A second 27B (`gemma3-27b`) | The fight. Two large models on one 24GB Mac |
| OS + Ollama / llama.cpp + kit | Always there; not free |

`gemma3-27b` in the Ask catalog is listed at **17 GB**. Two 27B-class
residents on one ~24GB Mac is the failure mode T060 names.

### 2.3 Measured Community Provide profile (ours, not vendor TG128)

Operator speed profile on M-series after:

- **8k ctx**
- **mmproj on CPU**
- **thinking off**
- **`-np 1`**

**Bonsai ≈ 13.3 tok/s.**

Live `/compute/api/network` on **2026-09-17 ~5:50 PM PT** (from
[#258](https://github.com/Uuriko/dasha-lobby/pull/258)):
`ternary-bonsai-2-27b` **~13.52 tok/s** next to `gemma3-27b`
**~6.64 tok/s**. Same order as the speed profile.

Vendor TG128 on an M4 Pro is ~18 tok/s (batch-1, depth 0, no vision
tower, short gen). That is **not** the Provide number. Do not paste
vendor TG128 onto the live gauge. The gauge is
`measured_providers ≥ 1` tok/s on `/compute/api/network`.

### 2.4 Interactive Provide: prefer 8B / 12B

On a ~24GB Community Mac, interactive Ask / mid-stream typing should
prefer the Mid / Speed residents. Quality (Bonsai) is the slower,
heavier rung — fine for a deliberate Quality pick, not the default
warm path.

Fresh live `/compute/api/network` **2026-09-18** (this note’s fetch;
`providers_online=1`; Bonsai **absent** on this read):

| Model | tok/s (measured) | Interactive default? |
| --- | --- | --- |
| `qwen3-4b` | 46.53 | Speed. Yes. |
| `qwen3-8b` | 25.18 | Mid. Yes. |
| `gemma3-12b` | 16.62 | Mid. Yes. |
| `ternary-bonsai-2-27b` | ~13.3–13.5 when advertised | Quality. Soft 24GB. |
| `gemma3-27b` | 6.64 | Demote after Bonsai stays live. |

Prefer 8B / 12B when the user is chatting. Load Bonsai when they pick
Quality **and** the Mac is not also holding `gemma3-27b`.

### 2.5 Operator note (docs / kit, not live lecture)

Keep this next to Community Provide in **docs**, not on the live
Provide canvas:

> ~24GB unified is the soft floor for Ternary Bonsai 2 27B. Use the
> speed profile (8k ctx, mmproj CPU, thinking off, `-np 1`). Prefer
> Qwen 8B / Gemma 12B for interactive. Do not serve Bonsai and
> gemma3-27b on the same 24GB Mac.

No “is hosting safe?” rewrite. No honesty essay mid-Ask.

---

## 3. T065 — Bonsai vs gemma3-27b (Ask ladder one-pager)

### 3.1 Compare

| Axis | `ternary-bonsai-2-27b` | `gemma3-27b` |
| --- | --- | --- |
| **Ladder face** | **Quality** when advertised | Current large multimodal; **demote** after Bonsai stays live |
| **Speed (ours)** | ~13.3 tok/s speed profile; 13.52 on network 2026-09-17 | 6.64 tok/s (2026-09-17 and 2026-09-18) |
| **Speed (vendor, not ours)** | PQ2_0 TG128 ~18 tok/s M4 Pro / ~28 M5 Pro | n/a here |
| **Quality class** | 27B ternary chat (PQ2 Community) | 27B multimodal (catalog 17 GB) |
| **RAM on ~24GB** | Weights ~7.2 GB; swap if long ctx / mmproj GPU / thinking / `-np`>1 / second 27B | Catalog 17 GB; fights Bonsai on the same Mac |
| **Ask default after demote** | Prefer when both advertised | Hide from default list; keep allowlist if a provider still maps it |
| **Hosted** | No. Community only | No. Hosted floor stays `gpt-oss-20b` |
| **SUB24** | No (27B Community, not a sub-24 specialist) | No |

Honesty copy after demote (picker faces only; not a thread essay):

**Speed** = `qwen3-4b` · **Mid** = `qwen3-8b` / `gemma3-12b` ·
**Quality** = `ternary-bonsai-2-27b`.

Needle / `needle-3` stays off `#ask-model`.

### 3.2 When to demote gemma (handoff to #258 — do not edit that PR)

[#258](https://github.com/Uuriko/dasha-lobby/pull/258) is the
**docs-draft** demote on dasha-lobby (`docs/GEMMA27-DEMOTE-AFTER-BONSAI.md`).
This note does not change that file.

**Merge / ship the demote code only when both are true:**

1. Live `/compute/api/network` lists `ternary-bonsai-2-27b` (re-read
   at ship time; do not freeze this note’s snapshot).
2. Instinct has tipped the [#248](https://github.com/Uuriko/dasha-lobby/pull/248)
   allowlist so Ask can select the id when advertised.

**2026-09-17 ~5:50 PM PT:** gate (1) was green (Bonsai + gemma both
advertised). **2026-09-18 this fetch:** gate (1) is **red** — Bonsai
is not in `models_available`. Re-check before merging #258. A single
green sample is not “stays live.”

Follow-up on #258 after the tip (their list, not ours):

1. Hide / demote `gemma3-27b` from the default Ask `#ask-model` list.
2. Prefer online default `ternary-bonsai-2-27b` over `gemma3-27b`
   when both are advertised.
3. Keep the `MODELS` allowlist entry if a provider still maps gemma.
4. Face copy: Speed / Mid / Quality as above.
5. Tests: SUB24 unchanged; Bonsai Community; `gpt-oss-20b` Hosted
   floor; skill copy no longer prefers gemma3-27b.

T032’s Advanced group stays **empty** until that demote lands. Do not
pre-fill Advanced from this note.

### 3.3 Decision

| If | Then |
| --- | --- |
| Bonsai advertised + 24GB Mac | Quality = Bonsai. Speed profile on. Do not also load gemma3-27b. |
| Bonsai advertised + interactive typing | Default Mid (8B / 12B). Quality is a pick, not the warm path. |
| Bonsai **not** advertised (this 2026-09-18 read) | Do not invent Bonsai. gemma3-27b may stay visible until the demote gate is green again. |
| Hosted / no Mac | `gpt-oss-20b` floor. Unchanged. |
| Edge / tools / extract | Needle later, not this ladder. |

---

## 4. Freshness

Dynamic counts must be re-read. This plan never freezes them as live
facts.

| When | Source | What it showed |
| --- | --- | --- |
| 2026-09-17 ~5:50 PM PT | [#258](https://github.com/Uuriko/dasha-lobby/pull/258) live check | `providers_online=1`; Bonsai ~13.52 tok/s; gemma3-27b ~6.64 tok/s |
| 2026-09-18 (this note) | `GET https://www.getdasha.com/compute/api/network` | `providers_online=1`; models `qwen3-4b` 46.53 · `qwen3-8b` 25.18 · `gemma3-12b` 16.62 · `gemma3-27b` 6.64; **Bonsai absent** |
| Catalog (tip) | dasha-lobby #248 / T032 spec | `ternary-bonsai-2-27b` in `MODELS` (Community, PQ2). Never invent when offline. |

---

## 5. Sources

| Source | Claim used | Confidence |
| --- | --- | --- |
| This task (T060 / T065) | Soft 24GB; 8k / mmproj CPU / thinking off / `-np 1` → ~13.3 tok/s; prefer 8B/12B interactive | Operator brief |
| dasha-lobby [#248](https://github.com/Uuriko/dasha-lobby/pull/248) | Allowlist `ternary-bonsai-2-27b`; Community; Hosted floor unchanged | High (merged) |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | Demote draft; 2026-09-17 13.52 vs 6.64; Speed/Mid/Quality | High (open draft — do not edit) |
| Live `/compute/api/network` 2026-09-18 | Current advertised set + tok/s; Bonsai absent on this read | High for that instant |
| [Ternary-Bonsai-2-27B-gguf](https://huggingface.co/prism-ml/Ternary-Bonsai-2-27B-gguf) | PQ2_0 7.21 GB; vendor TG128 on M-series | High for vendor pack; **not** our Provide tok/s |
| [ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md) | Keep Bonsai in `MODELS`; Advanced empty until #258 | High |
| Live `/compute` Provide copy | Soft doctor; measured tok/s; no RAM lecture today | High |

---

## 6. Acceptance checks

- [x] T060 states ~24GB as a **soft** Community Provide floor (swap
      risk, prefer 8B/12B interactive, speed profile 8k / mmproj CPU /
      thinking off / `-np 1` → ~13.3 tok/s)
- [x] No lecture copy proposed for the live Provide / Ask canvas
- [x] T065 one-pager compares speed / quality / RAM
- [x] Demote timing is gated on live advertise + #248 tip; #258 is
      cited and not edited
- [x] Distinct from Artifacts-lite and T042 / T043 paths
- [x] Fresh live read labeled; Bonsai absence on 2026-09-18 is not
      hidden
- [x] Needle not added to the Ask ladder
- [x] No wrangler, Worker, people-data, Designer, or `plugin.jup.ag`

---

## 7. Stay-outs

Quill login · Muse UI / paper faces · Instinct Phase 0 #8 / #9 ·
Designer-publish · people-data · `plugin.jup.ag` · direct wrangler ·
dasha-lobby edits (especially #258) · Ask regen / Continue (T042 /
T043) · Artifacts-lite · export / receipt writers · `#ask-model`
cmdk implement · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Companion picker spec: `docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md`.
Companion demote draft: dasha-lobby #258 (do not edit from here).
Companion T067 OpenAI error paths (bad URL / not ready / timeout /
thinking opt-in / kit Stop):
`research/ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md`.
Companion T068/T069 pause-on-battery + Prefer AC (no lecture):
`research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md`.
Companion T064 PrismML id map:
`research/ASK-PRISMML-BONSAI-ID-MAP-2026-09-18.md`.
Companion T071/T072 Advanced grouping + network honesty line:
`research/ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md`.*

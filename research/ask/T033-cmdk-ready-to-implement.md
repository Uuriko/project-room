# T033 — Ask ⌘K ready to implement

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask** (not Room)  
**Status:** Spec on main · **implement not started** · this is the go/no-go checklist  
**Plan refs:** T032 spec ([#491](https://github.com/Uuriko/project-room/pull/491) → [`docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md`](../../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md)) · **T033** (this page) · T071 ladder ([ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](../ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md)) · T075 placement ([ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md](../ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md))  
**Tip (source):** `Uuriko/dasha-lobby` `e6da8311` (includes #248 Bonsai, #255 quiet-shell, #257 SSR Mac, #259 PH retire, #261 Motley humans, #264 Needle-out / bonsai grow)  
**LIVE (probed 2026-09-18 ~01:32Z):** still Typeform — `#step-model`, “Which model?”, meta `Start. Do. Provide. Pay. Credits.`, no `#ask-model`, no `ternary-bonsai-2-27b`. `/compute/humans` 404 (not #261 308).

Ask is Compute’s chat door. Compute ≠ Room. No Typeform `Start.` / `Do.` return.

---

## 0. One line

Do **not** open a dasha-lobby T033 PR until Instinct tips quiet-shell live **and** Quill is off `dasha-compute.html` / `dasha-compute-page.mjs`. Then implement the #491 menu as a whisper pill + Raycast list. Keep Advanced empty.

---

## 1. Why checklist, not implement (this wave)

| Gate | State | Blocker? |
| --- | --- | --- |
| #491 cmdk spec on `project-room` main | **Yes** (`docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md`) | No |
| T033 implement PR / branch | **None** (search 2026-09-18) | — |
| Instinct wrangler of #248 / #255 / #261 / #264 | **No** — live still Typeform | **Yes** — spec §8: implement after quiet-shell is live |
| Quill compute HTML | **Open** [dasha-lobby #260](https://github.com/Uuriko/dasha-lobby/pull/260) `quill-s2/safe-auto-fixes` edits `dasha-compute.html` + embed + `dasha-lobby-worker.mjs` | **Yes** — same files T033 must touch |
| #258 gemma demote | Draft, gated on bonsai live | Soft — leave Advanced **empty**; do not hide `gemma3-27b` |

Full Raycast list + filter + ladder groups inside embedded `COMPUTE_PAGE_HTML` is **not** a small safe P0 while those gates are red. #491 already said so.

---

## 2. P0 must (copy from spec; do not invent)

- Preserve `#step-ask` `#ask-input` `#ask-send` `#ask-model` `#ask-composer` (add composer id if missing).
- Triggers: pill click, **⌘K / Ctrl+K**, **`/` only when `#prompt` is empty**.
- Same list for all three. Esc closes; thread uncleared. Enter-to-send stays when menu closed.
- Face groups: **Speed** (`qwen3-4b`) · **Mid** (`qwen3-8b`, `gemma3-12b`) · **Quality** (`ternary-bonsai-2-27b` when advertised) · **Advanced empty**.
- Keep `ternary-bonsai-2-27b` in `MODELS`. Never invent Bonsai offline. Needle is **not** an Ask model ([#264](https://github.com/Uuriko/dasha-lobby/pull/264)).
- Select path = today’s `#ask-model` change → `$('model').value` → `updateRun()`.
- Additive IDs only: `#ask-cmdk` `#ask-cmdk-list` `#ask-cmdk-filter` `[data-ask-cmdk-item]`.
- **Never revive** `#step-model` / Typeform “Which model?”.

Hosted: if the pill is hidden, ⌘K opens a one-row Hosted list (`gpt-oss-20b`) or no-ops with no toast — prefer the one-row list.

---

## 3. Files (when implement is allowed)

On **`Uuriko/dasha-lobby` only** (not this repo):

- `dasha-compute.html` — pill + `#ask-cmdk` + keydown
- `dasha-compute-page.mjs` — byte-identical embed
- tests: empty `/` opens; non-empty `/` types slash; ⌘K / Esc / focus; Bonsai select when advertised; Advanced child count `=== 0`; MODELS still has bonsai + `gemma3-27b`; less-is-more + ask-chat-ux (+ v2) + quiet-shell stay green

Claim those paths on #266 **after** #260 merges or dies. Do not edit a Quill branch.

---

## 4. Go / no-go (open T033 lobby PR only if all green)

- [ ] Live `/compute` has `#ask-model` whisper pill (not `#step-model` / “Which model?”)
- [ ] Live paints `ternary-bonsai-2-27b` when the network advertises it
- [ ] Live `/compute/humans` is 308 → `/humans.txt` (#261)
- [ ] No open Quill PR touching `dasha-compute.html` / `dasha-compute-page.mjs`
- [ ] #258 still the only gemma-demote owner (Advanced stays empty here)
- [ ] Claim on #266 for the exact lobby files, lane `grok-bot`

If any box is unchecked: **stop**. Do not “just add a keydown” on the Typeform live shell.

---

## 5. Stay-outs

Quill login / Room trees · Muse paper / home · Phase 0 [#8](https://github.com/Uuriko/project-room/pull/8) / [#9](https://github.com/Uuriko/project-room/pull/9) · Designer-publish · people-data · Potter keys · `plugin.jup.ag` · **direct wrangler** (tip Instinct only) · Provide / Host / Marketplace / Needle in the model menu · `client/` `cloudflare/` `server/` `src/` in **this** repo · dasha-lobby Worker HTML in this PR.

---

*End. Parent spec: [`docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md`](../../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md). Cousin: [`docs/ASK-QUIET-SHELL-V3.md`](../../docs/ASK-QUIET-SHELL-V3.md) §3.3.*

# T034 — Ask Artifacts-lite ready to implement

**Date:** 2026-09-18  
**Product:** getdasha.com/compute **Ask** (not Room)  
**Status:** Research on main · **implement not started** · this is the go/no-go checklist  
**Plan refs:** T034 research ([#493](https://github.com/Uuriko/project-room/pull/493) →
[`research/ASK-ARTIFACTS-LITE-2026-09-18.md`](../ASK-ARTIFACTS-LITE-2026-09-18.md)) ·
**T034** (this page) · quiet-shell §7 item 7 (full panel = P1)  
**Cousin checklist:** [T033 ⌘K](T033-cmdk-ready-to-implement.md) — same gates; different files/IDs  
**Tip (source):** `Uuriko/dasha-lobby` `e6da8311` (includes #248 Bonsai, #255 quiet-shell, #257 SSR Mac, #259 PH retire, #261 Motley humans, #264 Needle-out / bonsai grow)  
**LIVE (probed 2026-09-18 ~01:32Z, T033):** still Typeform — `#step-model`, “Which model?”, meta `Start. Do. Provide. Pay. Credits.`, no `#ask-model`, no `ternary-bonsai-2-27b`. `/compute/humans` 404 (not #261 308).

Ask is Compute’s chat door. Compute ≠ Room. Room “artifact” (editorial
rung on a Done receipt) is a **different noun**
([ROOM-ARTIFACT-MATURITY.md](../../docs/ROOM-ARTIFACT-MATURITY.md)).
No Typeform `Start.` / `Do.` return.

---

## 0. One line

Do **not** open a dasha-lobby T034 PR until Instinct tips quiet-shell
live **and** Quill is off `dasha-compute.html` / `dasha-compute-page.mjs`.
Then collapse **closed** fences > N lines → Expand / Open panel / Copy.
Empty Ask stays empty. No ⌘K work here (T033 owns that).

---

## 1. Why checklist, not implement (this wave)

| Gate | State | Blocker? |
| --- | --- | --- |
| #493 Artifacts-lite research on `project-room` main | **Yes** (`research/ASK-ARTIFACTS-LITE-2026-09-18.md`) | No |
| T034 implement PR / branch | **None** (search 2026-09-18) | — |
| Instinct wrangler of #248 / #255 / #259 / #261 / #264 | **No** — live still Typeform | **Yes** — research §7: implement after #246 / #249 / #255 live |
| Quill compute HTML | **Open** [dasha-lobby #260](https://github.com/Uuriko/dasha-lobby/pull/260) `quill-s2/safe-auto-fixes` edits `dasha-compute.html` + embed + `dasha-lobby-worker.mjs` | **Yes** — same files T034 must touch |
| T033 ⌘K checklist | [T033](T033-cmdk-ready-to-implement.md) also gated | Soft — do not combine ⌘K + Artifacts in one lobby PR |

Collapsing long fences inside embedded `COMPUTE_PAGE_HTML` is **not**
a small safe P0 while those gates are red. #493 already said so.

Quill #260 owns compute HTML. **Do not implement Ask ⌘K or
Artifacts-lite on lobby HTML yet.**

---

## 2. P0 must (copy from research; do not invent)

- **Trigger:** a **closed** markdown fence whose body is **> N lines**.
  Recommended **N = 16**. Short fences stay inline.
- **Do not collapse mid-stream.** Incomplete / streaming fences stay
  visible until the fence closes.
- Collapsed fence (in the bubble): language chip from the info string
  (`python` / `js` / `md` / `plain`) · first line or `N lines` as the
  title · **Expand** (inline, no panel) · **Open panel** · **Copy**
  (fence body only; same clipboard path as #249 Copy).
- Panel: desktop (≥ ~800px) side of `#step-ask`; narrow: bottom sheet
  above the composer. One panel at a time. Close / Esc returns focus
  to `#ask-thread`; **never** clears the thread. Read-only.
- **Empty Ask: no panel, no Artifacts icon, no collapsed-fence chrome.**
- Several long fences in one turn: each collapses independently. Panel
  shows the last one the user opened. Do not auto-advance.
- Preserve `#step-ask` `#ask-input` `#ask-send` `#ask-model`
  `#ask-composer` `#ask-thread` `#prompt` `#run-demo` and stream
  contracts (stop, partial keep, incomplete fences).
- Additive IDs only: `#ask-artifact-panel` `[data-ask-fence]`
  `[data-ask-fence-collapsed]`.
- **Never revive** `#step-model` / Typeform “Which model?” / `Start.` /
  `Do.` H1s.
- Needle is **not** an Ask model and not panel chrome
  ([#264](https://github.com/Uuriko/dasha-lobby/pull/264)).
- Hover Copy / Regen / Edit on the turn still work. Acid stays on
  Send / active only. Language chip is paper / muted.

---

## 3. Files (when implement is allowed)

On **`Uuriko/dasha-lobby` only** (not this repo):

- `dasha-compute.html` — fence collapse + `#ask-artifact-panel` + Esc
- `dasha-compute-page.mjs` — byte-identical embed
- tests: short fence stays inline; closed > N collapses; Expand
  inline; Open panel side vs bottom; Esc / close restores focus; Copy
  = fence body; streaming fence does not collapse; empty `#step-ask`
  has no `#ask-artifact-panel`; `#step-ask` `#ask-input` `#ask-send`
  `#ask-model` preserved; less-is-more + ask-chat-ux (+ v2) +
  quiet-shell stay green

Claim those paths on #266 **after** #260 merges or dies. Do not edit
a Quill branch. Do not share a claim with T033 unless Quill is gone
and both are sequenced (⌘K first or Artifacts first — not both in
one collide PR).

---

## 4. Go / no-go (open T034 lobby PR only if all green)

- [ ] Live `/compute` has `#ask-thread` + stream-safe MD (not Typeform
      `Start.` / `Do.` first paint)
- [ ] Live has `#ask-model` whisper pill (quiet-shell #255 / #249 tip)
- [ ] Instinct has wrangler'd current `Uuriko/dasha-lobby` main tip
      `e6da8311` (or newer: #248 / #255 / #259 / #261 / #264)
- [ ] No open Quill PR touching `dasha-compute.html` /
      `dasha-compute-page.mjs` ([#260](https://github.com/Uuriko/dasha-lobby/pull/260) closed or not those files)
- [ ] T033 is not mid-edit on the same HTML (or T033 already merged)
- [ ] Claim on #266 for the exact lobby files, lane `grok-bot`

If any box is unchecked: **stop**. Do not “just collapse fences” on
the Typeform live shell. Do not hang the panel off `#ask-model` ⌘K.

---

## 5. Must not (even after gates go green)

- Full IDE (file tree, tabs, apply / diff, Monaco, terminal)
- Auto-open panel, Artifacts library, public share URLs
- Execute or iframe untrusted HTML / React / SVG / Mermaid from the fence
- Edit the fence in the panel, or “iterate this artifact” as a separate object
- Write Room receipts / Work Items / maturity rungs
- Permanent Artifacts rail, library button, or “Workspace” tab
- New chrome on empty Ask
- Provide / Host / Marketplace / Needle as panel chrome
- Combine with T033 ⌘K, T042 regen, T043 Continue, T044 export, or
  Jev compact prune in the same lobby PR

---

## 6. Stay-outs

Quill login / Room trees · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
compute HTML (until clear) · Muse paper / home · Phase 0
[#8](https://github.com/Uuriko/project-room/pull/8) /
[#9](https://github.com/Uuriko/project-room/pull/9) · Designer-publish ·
people-data · Potter keys · `plugin.jup.ag` · **direct wrangler** (tip
Instinct only) · Room People-rail · Connect door HTML · Compute Start
blob · Needle as Ask chat · `client/` `cloudflare/` `server/` `src/`
in **this** repo · dasha-lobby Worker HTML in this PR · calling
Second a Genie.

---

*End. Parent research: [`research/ASK-ARTIFACTS-LITE-2026-09-18.md`](../ASK-ARTIFACTS-LITE-2026-09-18.md).
Cousin go/no-go: [`T033-cmdk-ready-to-implement.md`](T033-cmdk-ready-to-implement.md).
Quiet-shell: [`docs/ASK-QUIET-SHELL-V3.md`](../../docs/ASK-QUIET-SHELL-V3.md) §7 item 7 (full panel = P1).*

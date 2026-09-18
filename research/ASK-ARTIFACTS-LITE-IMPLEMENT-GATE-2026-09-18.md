# T081 — Artifacts-lite implement gate checklist

18 September 2026. Design-bound implement gate. Docs only. Not a
live Ask HTML edit and not a dasha-lobby implement PR.

**T081** — the **implement gate** for Ask Artifacts-lite. Research
and the T034 ready-to-implement page already exist. This note is
the claim lock: implementation may **not** open until every box
below is green. It does not invent UX.

Parents (cite only — do not rewrite):

- [#493](https://github.com/Uuriko/project-room/pull/493) P0 research:
  [ASK-ARTIFACTS-LITE-2026-09-18.md](ASK-ARTIFACTS-LITE-2026-09-18.md)
- [#507](https://github.com/Uuriko/project-room/pull/507) T034
  ready-to-implement:
  [ask/T034-artifacts-lite-ready-to-implement.md](ask/T034-artifacts-lite-ready-to-implement.md)

Companions (cite only):
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§3.5 empty state · §7 item 7 full panel = P1) ·
[T033 ⌘K gate](ask/T033-cmdk-ready-to-implement.md)
(same live / Quill blockers; different files/IDs) ·
[ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md](ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md)
(T074) ·
[UX-CLEAN-LESS-NOISE-2026-09-17.md](UX-CLEAN-LESS-NOISE-2026-09-17.md)
(rank 7 Artifacts) ·
T085 `#ask-thread` GFM subset
([ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md](ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md);
cite T041 #269; collapse is after render) ·
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).
Room “artifact” is a **different noun**:
[ROOM-ARTIFACT-MATURITY.md](../docs/ROOM-ARTIFACT-MATURITY.md).

**Tip (source):** `Uuriko/dasha-lobby` `2e7778e6` — T073
[#275](https://github.com/Uuriko/dasha-lobby/pull/275) capacity-dash
canary + Motley tip-source [#272](https://github.com/Uuriko/dasha-lobby/pull/272)
(`/humans.txt` TEAM face · `/compute/humans` 308). Includes #248
Bonsai, #255 quiet-shell, #257 SSR Mac, #259 PH retire, #261 Motley
humans, #264 Needle-out / bonsai grow, #267–#271 Ask canaries.
**LIVE (probed 2026-09-18 ~01:32Z, still current):** Typeform —
`#step-model`, “Which model?”, meta `Start. Do. Provide. Pay.
Credits.`, no `#ask-model`, no `ternary-bonsai-2-27b`.
`/compute/humans` 404 (not #261 / #272 308). Instinct wrangler of
tip is outstanding.

T076 Motley honesty (Demigod / Dasha `/humans.txt` +
`/compute/humans` faces, not Contribute redirect) is **already
covered on tip source** by [#272](https://github.com/Uuriko/dasha-lobby/pull/272)
`dasha-motley-tip-source-canary.test.mjs`. This fold does not
re-lock Motley.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

Do **not** claim Artifacts-lite on `dasha-compute.html` until live
quiet-shell is tipped **and** Quill is off that HTML. Then collapse
**closed** fences > N lines → Expand / Open panel / Copy. Empty Ask
stays empty. No ⌘K in the same lobby PR.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T034 research [#493](https://github.com/Uuriko/project-room/pull/493) | **Cite only.** P0 UX stays there. Do not rewrite `ASK-ARTIFACTS-LITE-2026-09-18.md` except a pointer. |
| T034 ready-to-implement [#507](https://github.com/Uuriko/project-room/pull/507) | **Cite only.** Go/no-go cousin. This page is the **later** implement gate (tip `2e7778e6`, Quill still open, T076 done). |
| T033 ⌘K ready-to-implement | **Cite only.** Same live / Quill blockers. Different IDs (`#ask-cmdk` vs `#ask-artifact-panel`). Never one lobby PR. |
| T071 / T072 ladder + honesty ([#518](https://github.com/Uuriko/project-room/pull/518)) | **Cite only.** Not a fence rewrite. |
| T074 Ask vs Provide ([#519](https://github.com/Uuriko/project-room/pull/519)) | **Cite only.** Panel is not a Provide door. |
| T075 Advanced ladder UX ([#520](https://github.com/Uuriko/project-room/pull/520), likely merging) | **Cite only.** Picker placement is not Artifacts. Do not rewrite that brief. |
| T073 capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275) `2e7778e6`) | **Hands-off.** Merged tests-only. Do not rewrite `dasha-compute-ask-capacity-dash-canary.test.mjs`. |
| T076 Motley faces (dasha-lobby [#272](https://github.com/Uuriko/dasha-lobby/pull/272)) | **Already done.** `/humans.txt` TEAM + `/compute/humans` 308 on tip source. Do not reopen. |
| Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Hands-off.** #260 owns `dasha-compute.html` + embed. Do not edit those PRs. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma demote waits. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform. No tip HTML. No wrangler. |
| T042 / T043 Regen / Continue · T044–T046 export / receipt / tok/s | **Not** this path. Hover Copy / Regen / Edit must keep working after fences collapse. |
| T068 / T069 battery / Prefer AC | **Not** this path. |

Paths this fold owns:

- `research/ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md` (this file)
- `tests/ask-artifacts-lite-implement-gate-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` (next to
  the existing Artifacts-lite rows, not the T074/T075 ladder rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#272` Motley rewrite ·
`#275` rewrite.

---

## 2. Why a second page (gate ≠ ready-to-implement)

[#507](https://github.com/Uuriko/project-room/pull/507) T034 is the
**ready-to-implement** cousin, written against tip `e6da8311`. This
T081 page is the **design-bound implement gate**
([ROOM-COHESIVE-ARCHITECTURE.md](../docs/ROOM-COHESIVE-ARCHITECTURE.md)
§4.4): design artifact exists, so a later implementer may **claim**
only after the live / Quill / collide boxes go green.

| Layer | PR | Job |
| --- | --- | --- |
| Design | #493 | P0 UX (N=16, Expand / Open panel / Copy, empty Ask quiet) |
| Ready-to-implement | #507 T034 | First go/no-go; files; stay-outs |
| **Implement gate** | **This page (T081)** | Re-check on current tip. Claim blocked until all boxes green. Sequence vs T033. |

T034 stays the file list and the P0 copy. T081 stays the **stop /
go** lock an implementer must re-read the day they open a lobby PR.

---

## 3. Gate table (re-checked 2026-09-18 ~02:40Z)

| Gate | State | Blocker? |
| --- | --- | --- |
| #493 Artifacts-lite research on `project-room` main | **Yes** | No |
| #507 T034 ready-to-implement on main | **Yes** (`research/ask/T034-artifacts-lite-ready-to-implement.md`) | No |
| T081 implement-gate page (this file) | **This PR** | No |
| T034 / T081 lobby implement PR / branch | **None** | — |
| Instinct wrangler of tip `2e7778e6` (#248 / #255 / #259 / #261 / #264 / #272 / #275) | **No** — live still Typeform | **Yes** |
| Quill compute HTML | **Open** [#260](https://github.com/Uuriko/dasha-lobby/pull/260) (and cousins #262 / #266 / #274). #260 edits `dasha-compute.html` + embed + worker | **Yes** — same files T034 must touch |
| T033 ⌘K | Still gated; same HTML | Soft — do not combine ⌘K + Artifacts in one lobby PR |
| T076 Motley honesty | **Done** on tip source (#272). Live leftover 308s still Instinct-gated | Soft — not an Artifacts file collide |
| #258 gemma demote | Draft | Soft — do not undraft; Advanced stays empty on T033 |

Collapsing long fences inside embedded `COMPUTE_PAGE_HTML` is **not**
a small safe P0 while those gates are red. #493 and #507 already
said so. The later tip (`2e7778e6`) did not clear them.

**Do not implement Ask ⌘K or Artifacts-lite on lobby HTML yet.**

---

## 4. Go / no-go (open a T034 lobby PR only if all green)

Re-check these the day of the claim. Do not trust this page’s
“~02:40Z” snapshot.

- [ ] Live `/compute` has `#ask-thread` + stream-safe MD (not
      Typeform `Start.` / `Do.` first paint)
- [ ] Live has `#ask-model` whisper pill (quiet-shell #255 / #249)
- [ ] Instinct has wrangler’d current `Uuriko/dasha-lobby` main tip
      `2e7778e6` or newer (#248 / #255 / #259 / #261 / #264 / #272 /
      #275)
- [ ] No open Quill PR touching `dasha-compute.html` /
      `dasha-compute-page.mjs` ([#260](https://github.com/Uuriko/dasha-lobby/pull/260)
      / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) closed
      or not those files)
- [ ] T033 is not mid-edit on the same HTML (or T033 already merged)
- [ ] Claim on #266 **after** #260 for the exact lobby files, lane
      `grok-bot` — or a later unclaimed lane. Do not edit a Quill
      branch.
- [ ] P0 copied from #493 / #507: closed fence > N (16), no
      mid-stream collapse, Expand / Open panel / Copy, empty Ask has
      no `#ask-artifact-panel`

If any box is unchecked: **stop**. Do not “just collapse fences” on
the Typeform live shell. Do not hang the panel off `#ask-model` ⌘K.
No wrangler from this repo.

---

## 5. P0 must (copy from #493 / #507; do not invent)

When the gate is green, implement **exactly** this on
`Uuriko/dasha-lobby` only:

- Trigger: a **closed** markdown fence whose body is **> N lines**.
  Recommended **N = 16**. Short fences stay inline.
- Do **not** collapse mid-stream.
- Collapsed fence: language chip · first line or `N lines` ·
  **Expand** (inline) · **Open panel** · **Copy** (fence body; same
  clipboard path as #249).
- Panel: desktop (≥ ~800px) side of `#step-ask`; narrow: bottom
  sheet above the composer. One panel. Close / Esc returns focus to
  `#ask-thread`; never clears the thread. Read-only.
- **Empty Ask: no panel, no Artifacts icon, no collapsed-fence
  chrome.**
- Preserve `#step-ask` `#ask-input` `#ask-send` `#ask-model`
  `#ask-composer` `#ask-thread` `#prompt` `#run-demo` and stream
  contracts.
- Additive IDs only: `#ask-artifact-panel` `[data-ask-fence]`
  `[data-ask-fence-collapsed]`.
- **Never revive** `#step-model` / Typeform “Which model?” /
  `Start.` / `Do.`
- Needle is **not** panel chrome
  ([#264](https://github.com/Uuriko/dasha-lobby/pull/264)).
- Hover Copy / Regen / Edit still work. Acid stays on Send.

Files when allowed: `dasha-compute.html` · `dasha-compute-page.mjs`
(byte-identical embed) · tests listed in #507 §3. Keep
less-is-more + ask-chat-ux (+ v2) + quiet-shell + T047 empty-canvas
+ T073 capacity-dash canaries green.

---

## 6. Must not (even after gates go green)

- Full IDE / auto-open panel / Artifacts library / public share URLs
- Execute or iframe untrusted HTML / React / SVG / Mermaid
- Edit the fence in the panel, or “iterate this artifact”
- Write Room receipts / Work Items / maturity rungs
- Permanent Artifacts rail or “Workspace” tab
- New chrome on empty Ask
- Provide / Host / Marketplace / Needle / capacity dash as panel
  chrome
- Combine with T033 ⌘K, T042 regen, T043 Continue, T044 export, or
  Jev compact prune in the same lobby PR
- Wrangler from project-room · undraft #258 · Quill HTML

---

## 7. Acceptance checks (this docs fold)

- [x] T081 is the Artifacts-lite **implement gate**, citing #493 and
      #507
- [x] States implement is still blocked (live Typeform + Quill #260
      HTML)
- [x] Names tip `2e7778e6` and T073 #275 merged; hands-off
- [x] Names T076 / #272 Motley tip-source canary as already done
- [x] Hands-off Quill #260 / #262 / #266 / #274
- [x] #258 stays draft
- [x] Sequence: never T033 + Artifacts in one lobby PR
- [x] P0 copied from #493 (N=16, Expand / Open panel / Copy, empty
      Ask quiet)
- [x] No dasha-lobby HTML, no wrangler, no Worker, no people-data,
      no Designer, no Potter keys
- [x] Room artifact noun stays separate
- [x] Second, never Genie

---

## 8. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
/ [#262](https://github.com/Uuriko/dasha-lobby/pull/262) /
[#266](https://github.com/Uuriko/dasha-lobby/pull/266) /
[#274](https://github.com/Uuriko/dasha-lobby/pull/274) compute HTML ·
Muse UI / paper faces · Instinct Phase 0 #8 / #9 · Designer-publish ·
people-data · `plugin.jup.ag` · **direct wrangler** · dasha-lobby
HTML / Worker / tests · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
dasha-lobby [#272](https://github.com/Uuriko/dasha-lobby/pull/272)
Motley rewrite · dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)
canary rewrite · T033 implement · T075 ladder UX rewrite · Ask regen
/ Continue (T042 / T043) · listing Needle as chat · calling Second a
Genie · `client/` `cloudflare/` `server/` `src/` `deploy/` in this
fold.

---

*End. Parents: #493 `research/ASK-ARTIFACTS-LITE-2026-09-18.md` ·
#507 `research/ask/T034-artifacts-lite-ready-to-implement.md`.
Cousin T033 gate: `research/ask/T033-cmdk-ready-to-implement.md`.
Quiet-shell: `docs/ASK-QUIET-SHELL-V3.md` §7 item 7 (full panel =
P1). Motley T076 already on tip: dasha-lobby #272.*

# T075 — Ask Advanced ladder UX brief

18 September 2026. UX placement brief. Docs only. Not a live Ask
HTML edit and not a dasha-lobby picker rewrite.

**T075** — Speed / Mid / Quality **picker placement**, and the
rule that empty Ask never dumps a **model essay**. Grouping stays
with T071. This note owns **placement**.

Parent grouping + honesty
([#518](https://github.com/Uuriko/project-room/pull/518)):
[ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md)
(T071 face groups · empty Advanced · T072 one expandable
`N Macs · models` line).

Companions (cite only):
[ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md)
(T032 triggers) ·
[ask/T033-cmdk-ready-to-implement.md](ask/T033-cmdk-ready-to-implement.md)
(T033 go/no-go) ·
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§3.3 quiet model chip · §3.5 empty state · §7 item 13) ·
[UX-CLEAN-LESS-NOISE-2026-09-17.md](UX-CLEAN-LESS-NOISE-2026-09-17.md)
(rank 3 chip · rank 13 labels). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

The ladder picker lives in the composer `#ask-model` whisper pill
and later `#ask-cmdk`. The empty canvas stays `What.` + ≤4 starters
— never a model essay, never Speed / Mid / Quality chips.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T071 / T072 grouping + honesty line ([#518](https://github.com/Uuriko/project-room/pull/518)) | **Cite only.** Do not rewrite face groups, Advanced-empty gates, or the `N Macs · models` line. |
| T032 / T033 ⌘K / slash menu | **Cite only.** Do not restyle `#ask-model`. Do not implement `#ask-cmdk`. |
| T074 Ask vs Provide boundary ([#519](https://github.com/Uuriko/project-room/pull/519)) | **Cite only.** Doors / dash / providers table stay off Ask. Not this placement rewrite. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** Tests-only canary. Do not reopen. Do not rewrite `dasha-compute-ask-capacity-dash-canary.test.mjs`. |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** Advanced stays empty. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform. No tip HTML. No wrangler. |
| T044–T046 export / receipt / tok/s | **Cite.** Empty-canvas ban is not a receipt and not mid-stream. |
| T068 / T069 battery / Prefer AC | **Not** this path. |

Paths this fold owns:

- `research/ASK-ADVANCED-LADDER-UX-BRIEF-2026-09-18.md` (this file)
- index rows on `research/README.md` and `docs/README.md`

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#275` rewrite.

---

## 2. Placement map

T071 already named the groups. T075 pins **where each face may
paint**. Empty `#ask-scroll` is not a picker.

| State | Speed / Mid / Quality? | Model essay? |
| --- | --- | --- |
| Cold empty `#ask-scroll` (no `has-chat`) | **No.** Greeting + ≤4 starters only. | **Never.** |
| Empty `#ask-thread` (hidden, no children) | **No.** | **Never.** |
| Composer idle (`#ask-composer`) | **Whisper pill only.** Short face (`Mid`) or short name inside `.ask-links`. T030: 12px / border 0 / transparent. | **No.** Pill is not a table. |
| Picker open (`#ask-cmdk`, later) | **Yes.** Group headers + primary rows. Advanced header, **empty** children. | Face labels. No GB / RAM / kit lecture on default rows. Soft tok/s only when `measured_providers ≥ 1`. |
| Hosted engine (`paintAskModel` hides the pill) | One-row Hosted list (`gpt-oss-20b`) or no-op. Prefer the one-row list. | **No** Hosted lecture on the canvas. |
| Network pending (`/compute/api/network` null) | Pill stays. Do not invent Quality / Bonsai. | **No** “Bonsai is coming” copy on first paint. |
| Mid-stream `#ask-think` / `.ask-said` | **No.** T046. | **No** tok/s essay. |
| Folded `#ask-receipt` | **No.** Receipt is per-turn (T045). | **No** ladder dump. |
| Provide Setup / doctor | **No.** | Operator copy stays on Provide. |

Copy bank on the **pill**: `Speed` · `Mid` · `Quality` · `Hosted` ·
`Community` · `My Mac`. Not a raw id scream (`gemma3-12b`). Not
“Which model?”.

Copy bank **inside** later `#ask-cmdk` only: those faces plus
`Advanced` as an empty header until #258. Raw ids stay muted
subtitles or Advanced.

---

## 3. Empty canvas — never dump a model essay

A **model essay** is any first-paint lecture that sells, compares,
or ranks models before the user asked. Forbidden on empty
`#ask-scroll` and the empty `#ask-thread`:

- Typeform `#step-model` / “Which model?”
- Full `MODELS[]` table (name · GB · tok/s · class)
- Speed / Mid / Quality chips used as empty-state starters
- A comparison grid / “pick a ladder” hero
- RAM / 24GB / kit version / `0.3.1` / vendor TG128
- “N providers” / Community Macs dump / `#ask-community` ink
- Invented Quality / Bonsai while the network has not stamped it
- Advanced explainer (“hidden models”, “power users”)

Allowed on that canvas:

- One greeting (`#ask-greet` → `What.`)
- At most four starter chips (`#ask-starters`) that **start a
  thread**, not a picker
- Hidden empty `#ask-thread`
- Sticky composer with the whisper pill **inside** `#ask-composer`

The pill may be visible while the canvas is empty. It is a composer
child, not a canvas child. T027 / T047 already lock starter count
and door chrome. T075 adds: those four starters are never ladder
faces.

---

## 4. Picker anatomy (when it *does* open)

Open **from the composer**, not from the canvas center.

| Piece | Placement |
| --- | --- |
| Trigger | `#ask-model` click / Enter / Space. **⌘K** / **Ctrl+K**. **`/`** only when `#prompt` is empty. |
| Menu | `#ask-cmdk` portal / fixed near `#ask-composer`. Prefer no dim backdrop. Mobile = full-width sheet **from the composer**. Touch ≥44px. |
| Groups | `.ask-cmdk-group` headers: Speed · Mid · Quality · Hosted (if shown) · Advanced. Mapping is T071. |
| Advanced | `.ask-cmdk-advanced` exists. Child count `=== 0` until #258. Do not pre-fill `gemma3-27b`. |
| Value owner | `#ask-model` / `$('model')` / `updateRun()`. Menu is a picker, not a second source of truth. |
| Close | Esc, outside click, second tap. Thread uncleared. Focus returns to `#prompt` or the pill. |

Do not:

- Mount `#ask-cmdk` as a canvas hero / empty-state panel
- Steal Enter-to-send while the menu is closed
- Put Provide / Host / Marketplace / Needle in the list
- Open the picker automatically on first paint

---

## 5. Existing tip canaries (cite, do not rewrite)

Quiet-shell locks already live on `Uuriko/dasha-lobby` **tip**
(source on main; live `/compute` still Typeform until Instinct
wrangler). T075 points at them. It does not re-open those PRs and
does not add HTML.

| Canary (tip) | Locks | Why T075 cites it |
| --- | --- | --- |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** `dasha-compute-ask-quiet-chrome-canary.test.mjs` | `#ask-model` whisper pill in composer `.ask-links`; 12px / border 0 / transparent; leftover `#step-model` hidden | **This is the picker home.** Labels live inside that pill’s later ⌘K list. |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** `dasha-compute-ask-empty-canvas-canary.test.mjs` | Empty `#ask-scroll` = `What.` + 4 starters. Provide / Host / Marketplace off canvas | Empty canvas is not a door row **and not a model essay**. |
| [#269](https://github.com/Uuriko/dasha-lobby/pull/269) **T050** `dasha-compute-ask-community-chip-canary.test.mjs` | No Community ink on empty `#ask-scroll` | No model / Mac dump disguised as Community. |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) `dasha-compute-ask-quiet-shell.test.mjs` | Chrome ≤15%. Thread + composer. | Parent shell the picker must not break. |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** `dasha-compute-ask-capacity-dash-canary.test.mjs` | No capacity dash / providers table / tok/s essay panel on Ask thread or empty canvas | **Hands-off.** Cite only. A model essay is the same class of dump. |

Disk == embed == `worker.fetch('/compute')` on those tip files.
Optional `LIVE_ASK_CANARY=1` fails honestly while live is Typeform.
Default off. T075 does not add a live fetch.

---

## 6. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Instinct tips quiet-shell live
**and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`, as part of
T033 (or a follow-up that claims the same files **after** #260):

- Keep the picker in the composer. Do not paint Speed / Mid /
  Quality on empty `#ask-scroll`.
- Group `#ask-cmdk` with empty `.ask-cmdk-advanced` (T071).
- Keep T030 / T047 / T050 / T073 canaries green.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275.

This repository ships the placement brief only.

---

## 7. Acceptance checks

- [x] T075 places Speed / Mid / Quality in the composer pill → later
      `#ask-cmdk`, not on the empty canvas
- [x] T075 bans a model essay on empty `#ask-scroll` / empty thread
- [x] Cross-links [#518](https://github.com/Uuriko/project-room/pull/518)
      `ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md`
- [x] Cites T030 whisper-pill canary (#270) and T047 empty-canvas
      canary (#268)
- [x] Quill #260 named as HTML blocker; hands-off
- [x] dasha-lobby #275 T073 named; hands-off; no rewrite
- [x] No dasha-lobby HTML, no wrangler, no Worker, no people-data,
      no Designer, no Potter keys
- [x] Advanced stays empty until #258
- [x] Needle not added as Ask chrome
- [x] Second, never Genie

---

## 8. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
compute HTML · Muse UI / paper faces · Instinct Phase 0 #8 / #9 ·
Designer-publish · people-data · `plugin.jup.ag` · **direct wrangler**
· dasha-lobby HTML / Worker / tests · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)
canary rewrite · T033 implement · Ask regen / Continue (T042 / T043)
· Artifacts-lite · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Parent grouping: #518
`research/ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md`.
Companion picker spec: `docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md`.
Companion T033 gate: `research/ask/T033-cmdk-ready-to-implement.md`.
Companion canaries: dasha-lobby #270 T030 · #268 T047 · #269 T050 ·
#255 quiet-shell · #275 T073 (hands-off).*

# T071 + T072 — Ask ladder Advanced grouping + network honesty line

18 September 2026. Combined research / spec note. Docs only. Not a
live Ask HTML edit and not a dasha-lobby picker rewrite.

**T071** — Speed / Mid / Quality face labels and **Advanced** grouping
for the Ask quiet-shell model list.
**T072** — Network honesty as **one expandable line**. Not a capacity
dashboard on Ask.

Companions (cite only):
[ASK-MODEL-CMDK-SPEC-2026-09-17.md](../docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md)
(T032) ·
[ask/T033-cmdk-ready-to-implement.md](ask/T033-cmdk-ready-to-implement.md)
(T033 go/no-go) ·
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§3.3 quiet model chip · §7 items 12–13) ·
[ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md](ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md)
(T060 + T065) ·
[ask/T045-receipt-collapse.md](ask/T045-receipt-collapse.md)
(T045 fold/expand steal) ·
[ask/T046-no-midstream-toks.md](ask/T046-no-midstream-toks.md)
(T046 stream lint). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

Group the quiet-shell picker as **Speed / Mid / Quality**, keep
**Advanced empty** until Bonsai stays live and #258 demotes gemma, and
show network honesty as one expandable `N Macs · models` line — never
a dashboard, never a lecture.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T032 / T033 ⌘K / slash menu | **Cite only.** Do not restyle `#ask-model`. Do not implement `#ask-cmdk`. |
| T060 / T065 Bonsai RAM + gemma ladder | **Cite only.** Quality = Bonsai when advertised. Soft 24GB. |
| T064 PrismML id map | **Cite only.** Public id stays `ternary-bonsai-2-27b`. |
| T044–T046 export / receipt / tok/s | **Cite.** T072 steals T045’s fold; T046 still bans mid-stream tok/s. |
| T042 / T043 Regen / Continue | **Not** this path. |
| T068 / T069 battery / Prefer AC | **Not** this path. |
| T074 Ask vs Provide boundary | **Cite only.** [ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md](ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md). Empty canvas / thread never host Provide doors, Host marketplace, capacity dash, or providers table. |
| T073 no-capacity-dash canary | **dasha-lobby, spinning.** Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** Demote waits until Bonsai stays advertised. |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) | **Quill owns** `dasha-compute.html` + embed. No live HTML here. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform. No tip HTML. No wrangler. |

Existing **source canaries** (cite, do not rewrite):

| Canary | Locks | Why T071 / T072 cite it |
| --- | --- | --- |
| dasha-lobby [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** `dasha-compute-ask-quiet-chrome-canary.test.mjs` | `#ask-model` whisper pill (`ask-model-pill` in composer `.ask-links`; 12px / border 0 / transparent; Hosted `paintAskModel` hides it; leftover `#step-model` stays hidden) | Ladder labels live **inside** that pill’s later ⌘K list. Do not scream a Speed/Mid/Quality chip row on the empty canvas. |
| dasha-lobby [#269](https://github.com/Uuriko/dasha-lobby/pull/269) **T050** `dasha-compute-ask-community-chip-canary.test.mjs` | Community chip **quiet vs scream**: empty `#ask-scroll` has no Community ink / no `#ask-community` dump; `#change-engine` + `#ask-model` stay composer 12px; `paintAskEngine` is one quiet `Community` word | T072 must not revive a Community Macs dump. Engine chip ≠ network strip. |

Paths this fold owns:

- `research/ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md` (this file)
- `tests/ask-ladder-advanced-honesty-docs.test.js`
- index rows on `research/README.md` and `docs/README.md`

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker · `#258` undraft.

---

## 2. T071 — Speed / Mid / Quality + Advanced grouping

Quiet-shell P1 item 13
([ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md) §7).
T032 already named the face labels. This note owns **grouping** and
the **Advanced** bucket so T033 does not invent one.

### 2.1 Face groups (primary)

Face labels on **primary** rows. Raw ids stay muted subtitles or
**Advanced**. Soft measured tok/s only when
`capacity.measured_providers ≥ 1` (T032 §4; T046).

| Group | Face | Model ids | When it appears |
| --- | --- | --- | --- |
| **Speed** | Speed | `qwen3-4b` | When advertised. SUB24. Interactive warm path. |
| **Mid** | Mid | `qwen3-8b`, `gemma3-12b` | When advertised. Default Community chat. |
| **Quality** | Quality | `ternary-bonsai-2-27b` | **Only** when the network advertises it. Never invent. |
| Hosted floor | Hosted | `gpt-oss-20b` | Hosted engine. Unchanged. One-row ⌘K list if the pill is hidden. |
| MoE / large | (no face hero) | `qwen3-30b-a3b` | When advertised. Not a Speed/Mid/Quality hero. |
| **Advanced** | Advanced | **empty in this ship** | Header only until #258. |

Needle / `needle-3` is **not** in any group (dasha-lobby #264 / T070).

### 2.2 Advanced stays empty (Instinct + Quill + Bonsai gates)

Do **not** pre-fill Advanced. Do **not** move `gemma3-27b` from this
note.

**Merge / ship the grouping on dasha-lobby only when all are true:**

1. Instinct has tipped quiet-shell live (`#ask-model` whisper pill,
   not Typeform `#step-model` / “Which model?”).
2. Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260) is off
   `dasha-compute.html` / `dasha-compute-page.mjs` (merged or not
   those files).
3. T033 go/no-go is green
   ([ask/T033-cmdk-ready-to-implement.md](ask/T033-cmdk-ready-to-implement.md)).

**Fill Advanced (gemma demote) only when both are also true:**

4. Live `/compute/api/network` lists `ternary-bonsai-2-27b` and it
   **stays** advertised (re-read at ship time).
5. Instinct has tipped the [#248](https://github.com/Uuriko/dasha-lobby/pull/248)
   allowlist so Ask can select that id.

Then [#258](https://github.com/Uuriko/dasha-lobby/pull/258) owns the
demote: `gemma3-27b` moves **into Advanced** (raw id visible there);
Quality prefers Bonsai. This note does not undraft #258.

Until then: Advanced child count `=== 0`. `MODELS` still includes
both `ternary-bonsai-2-27b` and `gemma3-27b`.

### 2.3 Where labels appear (and do not)

| Surface | Speed / Mid / Quality? |
| --- | --- |
| Later `#ask-cmdk` group headers (T032 / T033) | **Yes.** Primary rows. |
| `#ask-model` whisper pill selected face | **Yes, later** — short face (`Mid`) or short name. Not a raw-id scream. T030 canary stays: 12px / border 0 / in composer. |
| Empty Ask canvas / starter chips | **No.** T027 ≤4 starters. T042: no ladder chips on cold `#step-ask`. |
| Community / `#change-engine` chip | **No.** T050 one quiet `Community` word. Not “Community · Quality”. |
| Mid-stream `#ask-think` / `.ask-said` | **No.** T046. |
| Provide Setup / doctor | **No.** T068 / T069 / T060 docs. |

Copy bank: `Speed` · `Mid` · `Quality` · `Advanced` · `Hosted` ·
`Community` · `My Mac`. No “Which model?”. No GB essays on default
rows.

### 2.4 Implement later (not this repo)

On `Uuriko/dasha-lobby` after the gates in §2.2, as part of T033 (or
a follow-up that claims the same files **after** #260):

- Group `#ask-cmdk` with `.ask-cmdk-group` + empty `.ask-cmdk-advanced`.
- Keep `#ask-model` the value owner (`paintAskModel` / `$('model')`).
- Do not touch Quill’s HTML branch. Do not wrangler. Do not undraft #258.

Tip canaries already lock the chrome this grouping must not break
(#270 T030 pill · #269 T050 Community chip). New grouping tests belong
next to those files **after** the gates — not as a live HTML edit today.

---

## 3. T072 — Network honesty, one expandable line

Quiet-shell P1 item 12. Same honesty diet as
[HONEST-EMPTY.md](../docs/HONEST-EMPTY.md),
[BRIDGE-COMPUTE.md](../docs/BRIDGE-COMPUTE.md), and T045: short copy,
measured or `UNKNOWN`, fold by default.

### 3.1 Folded (default)

One muted line. Pick the **shortest true** face:

```
…
1 Mac · 4 models
No Macs
Honesty UNKNOWN
```

Rules:

- `…` while `/compute/api/network` is **pending / null**
  ([#257](https://github.com/Uuriko/dasha-lobby/pull/257) SSR Mac
  pending). Never first-paint `No Macs` or `1 Mac` from a guess.
- `N Mac` / `N Macs` only from stamped `providers_online`. Zero is
  `No Macs` — honest empty, not a failure.
- Model count only from stamped `models_available.length`. Do not
  invent Bonsai in the count when it is absent.
- No tok/s on the folded face. No kit version. No “measured
  providers” essay. No Provide / Host / Marketplace CTA.

### 3.2 Expanded (hover, focus, or tap)

Same honesty fields, still one panel — **not** a dashboard:

| Field | Rule |
| --- | --- |
| Model id | Each advertised id. Omit ids the network did not stamp. |
| tok/s | Per-model `tokens_per_second` only when that row’s `measured_providers ≥ 1`. Else `UNKNOWN` or omit. |
| Class | Optional `Community` / `Hosted` if Compute reported it. Not a Mac name dump. |

No kit version (`0.3.1`). No vendor TG128. No “is hosting safe?”.
Esc / mouseleave / second tap folds. Touch target ≥44px.

Steal T045’s fold contract: default collapsed; expand is opt-in;
never a lecture on first paint.

### 3.3 Placement

| Surface | Network line? |
| --- | --- |
| Compute chrome `#honesty-panel` / `#top-state` | **Yes** — this is the line. One line folded. |
| Ask first paint / empty `#ask-scroll` | **No.** Quiet-shell ≤15%. T047 / T050 already ban Provide / Community dumps on the canvas. |
| `#ask-model` pill / Community chip | **No.** Pill = selected model. Chip = engine word. |
| Stream faces (`#ask-think`, `.ask-said`, `#ask-run-chip`) | **No.** T046. |
| Folded `#ask-receipt` after complete | **Not this line.** Receipt is per-turn (T045). Network strip is fleet presence. |

If `#top-state` remains in the Ask header, it is still **one
expandable line**, measured-only, never-invent. It is not a second
primary CTA.

### 3.4 Freshness (do not freeze)

Dynamic counts must be re-read. This plan never freezes them as live
facts.

| When | Source | What it showed |
| --- | --- | --- |
| 2026-09-18 (this note) | `GET https://www.getdasha.com/compute/api/network` | `providers_online=1`; models `qwen3-4b` 46.53 · `qwen3-8b` 25.18 · `gemma3-12b` 16.62 · `gemma3-27b` 6.64; **Bonsai absent** |
| Folded face for that instant | — | `1 Mac · 4 models` (not `5`, not Bonsai) |
| Expanded face for that instant | — | those four ids + measured tok/s; no invented Quality row |

---

## 4. Acceptance checks

- [x] T071 maps Speed / Mid / Quality and keeps **Advanced empty**
      until Bonsai stays live + #258
- [x] T071 cites T030 `#ask-model` whisper-pill canary (#270) and
      T050 Community-chip canary (#269)
- [x] No live HTML / `#ask-model` restyle / `#ask-cmdk` implement
- [x] T072 is one expandable `N Macs · models` line; pending is `…`;
      unmeasured tok/s is `UNKNOWN` or omitted
- [x] T072 is not a Community dump, not a receipt, not mid-stream
- [x] #258 cited, not edited / not undrafted
- [x] Quill #260 + Instinct tip named as HTML blockers
- [x] Needle not added to the Ask ladder
- [x] No wrangler, Quill, Worker, people-data, Designer, Potter keys

---

## 5. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
compute HTML · Muse UI / paper faces · Instinct Phase 0 #8 / #9 ·
Designer-publish · people-data · `plugin.jup.ag` · **direct wrangler**
· dasha-lobby HTML / Worker · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
T033 implement PR · Ask regen / Continue (T042 / T043) ·
Artifacts-lite · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Companion picker spec: `docs/ASK-MODEL-CMDK-SPEC-2026-09-17.md`.
Companion T033 gate: `research/ask/T033-cmdk-ready-to-implement.md`.
Companion demote draft: dasha-lobby #258 (do not edit / undraft).
Companion canaries: dasha-lobby #270 T030 · #269 T050.
Companion T074 Ask vs Provide boundary:
`research/ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md`.*

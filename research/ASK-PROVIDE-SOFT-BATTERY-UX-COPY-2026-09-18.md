# T083 — Provide soft-battery UX copy brief

18 September 2026. UX copy brief. Docs only. Not a live Provide HTML
edit and not a dasha-lobby / kit rewrite.

**T083** — **quiet runtime copy** when a Community Mac is on battery
(or Low Power). No lecture. **No blocking Ask.**

Parents (cite only — do not rewrite):

- Room [#515](https://github.com/Uuriko/project-room/pull/515)
  **T068** pause-on-battery behavior + **T069** Prefer AC whisper:
  [ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md](ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md)

Companions (cite only):
[ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md](ASK-BONSAI-MAC24-AND-GEMMA-LADDER-2026-09-18.md)
(T060 + T065) ·
[ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md](ASK-BONSAI-PROVIDER-OPENAI-ERROR-PATHS-2026-09-18.md)
(T067) ·
[ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md](ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md)
(T074 — battery copy stays on Provide) ·
[ask/T046-no-midstream-toks.md](ask/T046-no-midstream-toks.md)
(T046 stream lint). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

**Tip (source):** `Uuriko/dasha-lobby` `2e7778e6` — T073
[#275](https://github.com/Uuriko/dasha-lobby/pull/275) + Motley
[#272](https://github.com/Uuriko/dasha-lobby/pull/272). **LIVE:**
still Typeform / no bonsai until Instinct wrangler. Instinct tipped.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

When the Mac is on battery, Provide whispers **On battery · paused**.
Ask keeps working. No lecture. No modal. No Ask block.

---

## 1. Why this is not a T068 / T069 rewrite

[#515](https://github.com/Uuriko/project-room/pull/515) already
named the **behavior** and the **idle Setup clause**. It did not
name the **runtime** line, or lock “Ask is never blocked.”

| Existing spec | What it already owns | What it does **not** name |
| --- | --- | --- |
| **T068** | Soft pause: drop advertise, no new lease, resume on AC. Not a doctor hard-fail | The words on the paused surface |
| **T069** | One idle Setup clause: **Prefer AC.** next to Prefer MLX | Runtime paused line. Ask no-block |
| **T074** | Battery / Prefer AC stay off the Ask canvas | The exact strings. The no-block rule |
| **T046** | No mid-stream kit lecture on Ask | Provide operator copy |
| **T083** | Runtime copy bank + **no blocking Ask** | Behavior. The Prefer AC clause |

T068 still owns pause. T069 still owns **Prefer AC.** T083 owns
the **paused** whisper and the Ask stay-open rule.

---

## 2. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T068 / T069 battery + Prefer AC ([#515](https://github.com/Uuriko/project-room/pull/515)) | **Cite only.** Do not rewrite `ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md` except a pointer. |
| T060 / T065 Bonsai RAM + gemma ladder | **Cite only.** Soft 24GB. Not a battery lecture. |
| T067 OpenAI error paths | **Cite only.** In-flight cancel is T067 abort, not “stopped because battery.” |
| T064 PrismML id map | **Cite only.** |
| T074 Ask vs Provide boundary ([#519](https://github.com/Uuriko/project-room/pull/519)) | **Cite only.** Battery copy stays on Provide. |
| T071 / T072 ladder + honesty ([#518](https://github.com/Uuriko/project-room/pull/518)) | **Cite only.** Fleet face is `N Macs · models`, not a battery essay. |
| T075 picker placement ([#520](https://github.com/Uuriko/project-room/pull/520)) | **Cite only.** Not this path. |
| T081 Artifacts-lite gate ([#521](https://github.com/Uuriko/project-room/pull/521)) | **Cite, do not rewrite.** |
| T082 Ask keyboard shortcuts ([#523](https://github.com/Uuriko/project-room/pull/523)) | **Merge separately.** Do not rewrite that brief. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma stays draft. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform / no bonsai. No tip HTML. No wrangler. |

Paths this fold owns:

- `research/ASK-PROVIDE-SOFT-BATTERY-UX-COPY-2026-09-18.md` (this file)
- `tests/provide-soft-battery-ux-copy-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` **next to
  the T068 / T069 battery rows** (not the T082 keyboard rows, not
  the T081 Artifacts-lite rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#275` rewrite · `#523`
keyboard rewrite · Mac Application Support edit · dasha-desk kit
rewrite.

---

## 3. Copy bank (quiet)

Idle Setup whisper stays T069. This table is the **runtime** bank
when the box is actually on battery or Low Power.

| State | Surface | Copy | Not |
| --- | --- | --- | --- |
| Idle Setup (AC, or power unknown) | Provide Setup whisper | T069: **Prefer AC.** next to Prefer MLX | A new sentence. A tooltip essay. |
| On battery, already providing | Provide status, **muted** | `On battery · paused` | Banner. Toast. Modal. Third accent. |
| Low Power Mode | Same line | `Low Power · paused` | A Low Power sermon. |
| Back on AC | Same line | **Clear.** Resume advertise (T068) | “Welcome back.” “Resumed.” |
| Doctor | Existing soft-warn | `battery / Low Power / thermal / SIP · never fails solely` | Hard-fail. Register block. |
| In-flight cancel | Bonsai OpenAI lane | T067 abort. Keep the partial. | “Stopped because battery.” |
| Ask empty canvas / thread / mid-stream / `#ask-model` | — | **Nothing** | Chip. Toast. Error. Block. |
| Ask routing | Network honesty | T072 `N Macs · models` drops if this Mac left advertise | “This Mac is on battery.” |

That is the whole bank. **On battery · paused** — middot, two
words plus `paused`, same whisper class as Prefer MLX / Prefer AC.
Period stays on the T069 clause only.

Desktop / always-AC: no-op. Do not fake a paused line.

---

## 4. No blocking Ask

Distinctive T083 rule. T068 already said “do not lecture Ask.”
This note locks the Ask **door**.

- A paused Mac is **offline for advertise** (T068). Ask does not
  wait on it and does not own its power state.
- Do **not** return a battery error to Ask. Do not map pause to
  `4xx` / `5xx` / empty successful `stop`.
- Do **not** disable `#ask-input` / `#ask-send` / `#run-demo`.
- Do **not** paint a battery chip on `#ask-model`, empty
  `#ask-scroll`, or the thread.
- If this was the only Community Mac, T072 becomes `No Macs` (or
  Hosted still works). That is honesty, not a lecture.
- Hosted floor (`gpt-oss-20b`) stays selectable. Other advertised
  Macs stay selectable.
- Never invent `ternary-bonsai-2-27b` as “unavailable because
  battery.” Live network still has **no bonsai**. Absence is T072,
  not a T083 string.

Ask may keep streaming a lease this Mac already took (T068
in-flight: finish or T067-cancel). The **next** Ask turn does not
see a battery wall.

---

## 5. Voice (same diet as T069 / T046)

Allowed words: `On battery` · `paused` · `Low Power` · `Prefer AC.`

Forbidden (lecture / block):

- “For best performance, plug in your Mac.”
- “Ask is unavailable while on battery.”
- “Quality Bonsai needs AC.”
- Percent remaining / time-to-empty / “15% left”
- Modal, blocking dialog, FAQ rewrite, permanent chip **plus**
  banner **plus** tooltip (one muted line is the diet)
- Hosted-vs-Community sermon
- Mid-stream tok/s / kit / RAM essay (T046 / T060 stay cited)

Register → Setup stays open on battery. Doctor **warns**. It does
not fail solely. Not attestation.

---

## 6. Existing tip canaries (cite, do not rewrite)

| Canary (tip) | Locks | Why T083 cites it |
| --- | --- | --- |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** | Empty `#ask-scroll` = `What.` + 4 starters | No battery dump on empty Ask |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** | `#ask-model` whisper pill; hover actions | No battery chip on the pill |
| [#269](https://github.com/Uuriko/dasha-lobby/pull/269) **T050** | No Community dump on empty Ask | Pause ≠ Community lecture |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) | Chrome ≤15% | No battery banner |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** | No capacity dash | **Hands-off** |

Live `/compute` is still Typeform. T083 does not add a live fetch
and does not wrangler.

---

## 7. Implement later (not this repo)

On the Mac / kit **and** Provide Setup, after Instinct tips
quiet-shell live **and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`:

- T068 pause advertise. T069 **Prefer AC.** T083 `On battery · paused`.
- Ask stays unblocked. No dasha-lobby Ask HTML in that kit PR.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275. Do not combine
  with T082 (#523) or T081 Artifacts in the same lobby PR.

This repository ships the copy brief only.

---

## 8. Acceptance checks

- [x] T083 is the **runtime** soft-battery copy brief, citing Room
      [#515](https://github.com/Uuriko/project-room/pull/515) T068 / T069
- [x] Names `On battery · paused` / `Low Power · paused`; Prefer AC
      stays T069
- [x] States **no lecture** and **no blocking Ask**
- [x] Ask empty / thread / mid-stream / `#ask-model` get **nothing**
- [x] Doctor / Register stay soft (not a hard-fail)
- [x] Quill #260 / #262 / #266 / #274 named; hands-off
- [x] dasha-lobby #275 T073 named; hands-off
- [x] #258 stays draft
- [x] T082 / #523 named; merge separately
- [x] Live Typeform / no bonsai named; no wrangler
- [x] Index rows sit next to T068 / T069, not T082 / T081
- [x] No dasha-lobby HTML, no Worker, no people-data, no Designer,
      no Potter keys
- [x] Needle not added as Ask chrome
- [x] Second, never Genie

---

## 9. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
/ [#262](https://github.com/Uuriko/dasha-lobby/pull/262) /
[#266](https://github.com/Uuriko/dasha-lobby/pull/266) /
[#274](https://github.com/Uuriko/dasha-lobby/pull/274) compute HTML ·
Muse UI / paper faces · Instinct Phase 0 #8 / #9 · Designer-publish ·
people-data · `plugin.jup.ag` · **direct wrangler** · dasha-lobby
HTML / Worker / tests · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)
canary rewrite · T082 / [#523](https://github.com/Uuriko/project-room/pull/523)
keyboard rewrite · T081 / #521 Artifacts-lite rewrite · T068 / T069
behavior rewrite · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Parent: Room #515
`research/ASK-PROVIDE-BATTERY-PREFER-AC-2026-09-18.md` (T068 / T069).
Companion boundary: T074. Companion honesty: T072. Companion
canaries: dasha-lobby #268 T047 · #270 T030 · #269 T050 · #255
quiet-shell · #275 T073 (hands-off).*

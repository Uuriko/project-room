# T087 — Ask receipt / lastPaidReceipt whisper brief

18 September 2026. Job-id whisper brief. Docs only. Not a live Ask
HTML edit and not a dasha-lobby `#ask-receipt` rewrite.

**T087** — when `#ask-receipt` shows **Job id**.
[T045](ask/T045-receipt-collapse.md)
([#496](https://github.com/Uuriko/project-room/pull/496)) already
owns the chrome: honesty folds after complete; hover/focus expand;
`lastPaidReceipt` is the source of truth. This note names the
**Job whisper** — the id appears only on expand, only when
`lastPaidReceipt` has a job id — and that the chip is **never a
capacity dash**.

Parents (cite only — do not rewrite):

- [T045](ask/T045-receipt-collapse.md)
  ([#496](https://github.com/Uuriko/project-room/pull/496))
  Receipt collapse after complete — folded face; expand fields;
  no empty-canvas receipt
- dasha-lobby `#ask-receipt` / `paintAnswerReceipt()` /
  `lastPaidReceipt` / `honestyFieldsFrom` on tip
  `dasha-compute.html`

Companions (cite only):
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§3.6 one-word stream; T045 row) ·
[ask/T046-no-midstream-toks.md](ask/T046-no-midstream-toks.md)
(no Job / tok/s mid-stream) ·
[ask/T044-quiet-export-transcript.md](ask/T044-quiet-export-transcript.md)
(export `job_id` is a **file** field, not this chip) ·
[ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md](ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md)
(T074 — Ask never hosts a capacity dash) ·
[ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md)
(T072 `N Macs · models` is `#honesty-panel`, not `#ask-receipt`) ·
[ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md](ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md)
(T084 — New clears the thread and the leftover receipt). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

**Tip (source):** `Uuriko/dasha-lobby` `2e7778e6` — T073
[#275](https://github.com/Uuriko/dasha-lobby/pull/275) + Motley
[#272](https://github.com/Uuriko/dasha-lobby/pull/272). Includes
#246 / #249 / #255 quiet-shell. **LIVE:** still Typeform / no
bonsai until Instinct wrangler. Instinct tipped.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

`#ask-receipt` whispers **Job** only after complete, only on
expand, and only when `lastPaidReceipt` has a job id. The chip
is never a capacity dash.

---

## 1. Why this is not a T045 rewrite

[#496](https://github.com/Uuriko/project-room/pull/496) T045 already
owns **when the chip exists** and that expand may list Job id as
“exact run reference.” It sketches folded faces
(`Receipt` / `Community · tok/s` / `Honesty UNKNOWN`) and says
empty canvas / no `lastPaidReceipt` invents nothing. It does not
lock **folded-face omit**, **no `Job: null`**, **no capacity poll**,
or **chip ≠ dash**.

| Existing spec | What it already owns | What it does **not** name |
| --- | --- | --- |
| T045 [#496](https://github.com/Uuriko/project-room/pull/496) | Fold after complete; hover expand; `#ask-receipt` id; `lastPaidReceipt` source; Job as an expand field | When Job is **shown** vs omitted. Folded-face ban. `Job: null` ban. Chip vs capacity dash |
| T046 | No tok/s / Job mid-stream | The complete-state Job whisper |
| T044 | Export `job_id` from `lastPaidReceipt` or `null` | The thread chip |
| T074 | Ask never hosts a capacity dashboard / providers table | That **this chip** is not that dash |
| T072 | One expandable `N Macs · models` on `#honesty-panel` | Per-turn Job id |
| T073 [#275](https://github.com/Uuriko/dasha-lobby/pull/275) | Lobby no-capacity-dash canary | The receipt Job rule |
| T086 [#527](https://github.com/Uuriko/project-room/pull/527) | Export header Job line (merge separately) | `#ask-receipt` face |
| **T087** | Job whisper: expand-only, `lastPaidReceipt` id or omit. Never a capacity dash | The fold chrome. The export file. The canary |

T045 still owns the fold. T087 owns the **Job whisper** and the
**dash ban on this chip**.

---

## 2. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T045 receipt fold ([#496](https://github.com/Uuriko/project-room/pull/496)) | **Cite only.** Same `#ask-receipt`. Do not restyle the fold. |
| T046 mid-stream tok/s | **Cite only.** No Job / tok/s while `askBusy`. |
| T044 export chrome ([#496](https://github.com/Uuriko/project-room/pull/496)) | **Cite only.** File `job_id` is not this chip. |
| T086 Export thread format ([#527](https://github.com/Uuriko/project-room/pull/527)) | **Merge separately.** Do not rewrite that brief. |
| T074 Ask vs Provide ([#519](https://github.com/Uuriko/project-room/pull/519)) | **Cite only.** Dash ban is the surface; T087 applies it to the chip. |
| T072 network honesty ([#518](https://github.com/Uuriko/project-room/pull/518)) | **Cite only.** `N Macs · models` stays `#honesty-panel`. |
| T084 New chat / Clear thread ([#525](https://github.com/Uuriko/project-room/pull/525)) | **Cite only.** New drops `lastPaidReceipt` with the thread. |
| T085 markdown render ([#526](https://github.com/Uuriko/project-room/pull/526)) | **Cite, do not rewrite.** Receipt is not markdown. |
| T082 keys ([#523](https://github.com/Uuriko/project-room/pull/523)) | **Cite only.** No letter for the receipt. Esc folds (T045), never New. |
| T047 empty canvas ([#268](https://github.com/Uuriko/dasha-lobby/pull/268)) | **Cite only.** Empty stays `What.` + ≤4 starters. No receipt. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma stays draft. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform / no bonsai. No tip HTML. No wrangler. |

Paths this fold owns:

- `research/ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md` (this file)
- `tests/ask-receipt-lastpaid-whisper-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` **next to
  the T045 receipt rows** (not the T085 markdown rows, not the T084
  New-chat rows, not the T086 export-format rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#275` rewrite · `#496`
T045 rewrite · `#527` T086 rewrite · `#526` T085 rewrite · `#525`
New-chat rewrite.

---

## 3. When `#ask-receipt` shows Job id

`lastPaidReceipt` (or `honestyFieldsFrom` when that is the same
object) is the **only** source. Do not re-measure. Do not poll
capacity. Do not invent from a providers table.

| Turn / data | Job on `#ask-receipt`? |
| --- | --- |
| `thinking` / `streaming` / `queued` / `askBusy` | **None.** T046. |
| Empty canvas / no `lastPaidReceipt` | **None.** Do not invent a receipt (T045). |
| Complete / stopped / error — folded face | **None.** Folded stays the shortest true face (`Receipt` / `Community · tok/s` / `Honesty UNKNOWN`). Job is not the fold. |
| Complete / stopped / error — **expanded** — `lastPaidReceipt` has a job id | **Yes.** Whisper the exact run reference. |
| Expanded — `lastPaidReceipt` missing or has no id | **Omit** the Job line. Do not write `Job: null` or `Job: UNKNOWN`. |
| Hosted complete, id present, no measured Mac tok/s | Job may show. tok/s stays `UNKNOWN` or omitted (T045). Not a Hosted boast. |
| After **New** (`#clear-chat`) | **None.** The thread and `lastPaidReceipt` clear together (T084). |

Field names on the object, first hit wins: `job_id` · `jobId` ·
`id` when that id is the Compute run reference (not a Room
`workItemId`, not a provider / Mac id, not a model id).

Optional `/verify?hash=` link **only** when `lastPaidReceipt`
already has a hash. Do not mint a hash in the client.

Copy, when shown:

```
Job: job_abc123
```

Short. No “Chained to the public receipt log.” No kit version.

---

## 4. Never a capacity dash

`#ask-receipt` is one **per-turn honesty chip**. It is not fleet
chrome. T074 already bans a capacity dashboard on the Ask canvas /
thread. T087 applies that ban to **this node**.

Forbidden on `#ask-receipt` (folded or expanded):

- Providers table / named Mac rows / market table
- Mac grid, kit version, RAM lecture, llama.cpp / Ollama essay
- “N providers” / live capacity polling / `/capacity` fetch
- T072 `N Macs · models` (that line is `#honesty-panel` / `#top-state`)
- Provide / Host / Marketplace doors (`#ask-provide` / `#ask-host` /
  `#ask-ocm`)
- tok/s **essay panel** (one measured `tok/s` on the T045 folded
  face is allowed; a speed dashboard is not)
- `room.receipt.v1` (`workItemId`, personas, `peopleData`, Cua)
- Session tokens, emails, X handles, wallets, Potter keys
- `plugin.jup.ag`

Expanded **Raw** `<details>` (T045) stays the JSON object already
on `#rcpt-raw`. Default closed. It is not a capacity payload and
not a second dash.

T073
([#275](https://github.com/Uuriko/dasha-lobby/pull/275)
`dasha-compute-ask-capacity-dash-canary.test.mjs`) stays
**hands-off**. This note does not rewrite that canary.

---

## 5. Preserve IDs / seams

| ID / seam | Role |
| --- | --- |
| `#ask-receipt` | The chip. Job whisper lives here on expand. Never a dash. |
| `#ask-receipt-face` / `#ask-receipt-detail` | T045 additive. Face = fold; detail = Job when present. |
| `lastPaidReceipt` / `honestyFieldsFrom` | Source of truth. |
| `#ask-mac-line` | Hidden on Ask unless expand needs one Mac name. Not a fleet strip. |
| `#ask-run-chip` | Done flash only. Not Job. |
| `#ask-think` | Stream word only. Never Job. |
| `#honesty-panel` / `#top-state` | T072 network line. Not this chip. |
| `#rcpt` / `#answer-receipt` | Typeform Answer leftovers. Do not restyle into Ask. |
| `stayAskChat` | Completing a run must not bounce to `#step-answer`. |

`#ask-receipt` node id stays. Do not delete it. Do not grow it
into `#honesty-panel`.

---

## 6. Existing tip canaries (cite, do not rewrite)

| Canary (tip) | Locks | Why T087 cites it |
| --- | --- | --- |
| T045 [#496](https://github.com/Uuriko/project-room/pull/496) | Fold / expand; no empty-canvas receipt | **Parent spec** |
| [#249](https://github.com/Uuriko/dasha-lobby/pull/249) `dasha-compute-ask-chat-ux-v2.test.mjs` | A7 New clears `has-chat` | New drops the leftover Job |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** | Empty = `What.` + 4 starters | No receipt dump on empty |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** | Hover-only actions; `#ask-model` whisper | Receipt is hover-expand, not a rail |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) | Chrome ≤15% | No lecture / dash |
| [#271](https://github.com/Uuriko/dasha-lobby/pull/271) **T046** leftovers | Mid-stream tok/s off | Mid-stream Job off |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** | No capacity dash | **Hands-off** |

Live `/compute` is still Typeform. T087 does not add a live fetch
and does not wrangler.

---

## 7. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Instinct tips quiet-shell live
**and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`:

- Keep T045 fold. Write the T087 Job whisper. Expand-only. Omit
  when `lastPaidReceipt` has no id.
- Do not grow `#ask-receipt` into a capacity dash / providers
  table / T072 fleet line.
- Keep T047 / T030 / T046 / quiet-shell + ask-chat-ux v2 green.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275. Do not combine
  with T086 export format, T085 render, T084 New-chat, T082 keys,
  T083 battery, or T081 Artifacts in the same lobby PR.

This repository ships the brief only.

---

## 8. Acceptance checks

- [x] T087 is the Ask receipt / `lastPaidReceipt` **whisper**
      brief, citing T045
      [#496](https://github.com/Uuriko/project-room/pull/496)
- [x] Names **when `#ask-receipt` shows Job id** — expand-only,
      only when `lastPaidReceipt` has an id
- [x] Folded face never shows Job
- [x] Missing id **omits** the line — no `Job: null` / `Job: UNKNOWN`
- [x] Mid-stream / empty canvas / after New = no Job
- [x] `#ask-receipt` is **never a capacity dash** (no providers
      table, no fleet grid, no `/capacity` poll, no T072 line)
- [x] T072 / T074 / T073 cited; chip ≠ `#honesty-panel`
- [x] T046 cited; no Job mid-stream
- [x] T044 cited; export `job_id` is a file field
- [x] T086 / #527 named; merge separately
- [x] T085 / #526 cited; not rewritten
- [x] T084 / #525 cited; New clears leftover receipt
- [x] Quill #260 / #262 / #266 / #274 named; hands-off
- [x] dasha-lobby #275 T073 named; hands-off
- [x] #258 stays draft
- [x] Live Typeform / no bonsai named; no wrangler
- [x] Index rows sit next to T045, not T085 / T084
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
canary rewrite · T045 / [#496](https://github.com/Uuriko/project-room/pull/496)
chrome rewrite · T086 / [#527](https://github.com/Uuriko/project-room/pull/527)
export-format rewrite · T085 / [#526](https://github.com/Uuriko/project-room/pull/526)
markdown rewrite · T084 / [#525](https://github.com/Uuriko/project-room/pull/525)
New-chat rewrite · T082 / [#523](https://github.com/Uuriko/project-room/pull/523)
keyboard rewrite · T083 / [#524](https://github.com/Uuriko/project-room/pull/524)
battery rewrite · T081 / #521 Artifacts-lite rewrite · T074 / T072
rewrite · T033 implement · listing Needle as chat · calling Second
a Genie · `client/` `cloudflare/` `server/` `src/` `deploy/` in
this fold.

---

*End. Parent: T045 [#496](https://github.com/Uuriko/project-room/pull/496)
receipt collapse.
Companion stream: T046 (no Job mid-stream).
Companion export: T044 (file `job_id`, not this chip).
Companion dash: T074 / T073 (hands-off).
Companion network: T072 (`#honesty-panel`, not `#ask-receipt`).
Companion canaries: #496 T045 · #249 v2 · #268 T047 · #270 T030 ·
#255 quiet-shell · #271 leftovers · #275 T073 (hands-off).*

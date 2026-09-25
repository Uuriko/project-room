# T086 — Ask Export thread format brief

18 September 2026. Thread-format brief. Docs only. Not a live Ask
HTML edit and not a dasha-lobby `#ask-export` rewrite.

**T086** — what the Ask **Export** file actually contains.
[T044](ask/T044-quiet-export-transcript.md)
([#496](https://github.com/Uuriko/project-room/pull/496)) already
owns the chrome: hover Export on thread only; JSON + MD download;
absent on empty canvas. This note names **markdown download vs
copy**, and which **headers / model / receipt lines** ship.

Parents (cite only — do not rewrite):

- [T044](ask/T044-quiet-export-transcript.md)
  ([#496](https://github.com/Uuriko/project-room/pull/496))
  Quiet export transcript JSON/MD — thread chrome; client
  `conversation[]` download; not Room export
- dasha-lobby [#249](https://github.com/Uuriko/dasha-lobby/pull/249)
  Ask chat UX v2 **A3 Copy** — per-turn clipboard; flashes
  **Copied**

Companions (cite only):
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§3.4 hover Copy; T044 row) ·
[ask/T045-receipt-collapse.md](ask/T045-receipt-collapse.md)
(T045 folded receipt face — tok/s stays there) ·
[ask/T046-no-midstream-toks.md](ask/T046-no-midstream-toks.md)
(no tok/s essay in the file or the button) ·
[ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md](ASK-KEYBOARD-SHORTCUTS-BRIEF-2026-09-18.md)
(T082 **C** is per-turn Copy, not Export) ·
[ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md](ASK-NEW-CHAT-CLEAR-THREAD-BRIEF-2026-09-18.md)
(T084 — New removes Export) ·
[ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md](ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md)
(T085 — export writes source, not `innerHTML`). Fold lock:
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

Export **MD** is a **thread download**. Per-turn **Copy** stays
clipboard. The file header ships **Engine**, **Model**,
**Exported**; **Job** only when `lastPaidReceipt` has a `job_id`.
No invented tok/s.

---

## 1. Why this is not a T044 rewrite

[#496](https://github.com/Uuriko/project-room/pull/496) T044 already
owns **where** Export lives and that both JSON and MD **download**.
It sketches a header and says **Copied** is for Copy, Export may
flash **Saved**. It does not lock download vs clipboard as two
verbs, and it does not name which receipt lines may appear in the
file.

| Existing spec | What it already owns | What it does **not** name |
| --- | --- | --- |
| T044 [#496](https://github.com/Uuriko/project-room/pull/496) | Thread-only `#ask-export`; JSON + MD `Blob` download; empty-canvas no; `dasha.ask.transcript.v1`; not Room export | Download vs Copy as a format rule. Which header / model / receipt lines ship. Job omit-when-null on MD |
| Ask v2 [#249](https://github.com/Uuriko/dasha-lobby/pull/249) **A3** | Per-turn Copy → clipboard; **Copied** | Whole-thread file. Header bank |
| T082 | Letter **C** = Copy | Export has no letter |
| T045 | Folded receipt face on the thread; tok/s measured or `UNKNOWN` | Receipt lines inside the export file |
| T046 | No mid-stream tok/s | File-header tok/s ban (this note) |
| T085 | `#ask-thread` GFM diet; export is source text | Header / Job lines |
| **T086** | MD download ≠ Copy. Header / model / receipt line bank | The chrome. The JSON schema. The canary |

T044 still owns the control. T086 owns the **format**.

---

## 2. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T044 export chrome ([#496](https://github.com/Uuriko/project-room/pull/496)) | **Cite only.** Same `#ask-export`. Do not restyle the hover. |
| Ask v2 A3 Copy ([#249](https://github.com/Uuriko/dasha-lobby/pull/249)) | **Cite only.** Clipboard stays one bubble. |
| T045 receipt fold | **Cite only.** tok/s stays on the chip, not the file header. |
| T046 mid-stream tok/s | **Cite only.** No tok/s in the button or the file. |
| T082 keys ([#523](https://github.com/Uuriko/project-room/pull/523)) | **Cite only.** **C** is Copy. Export has no letter. |
| T084 New chat / Clear thread ([#525](https://github.com/Uuriko/project-room/pull/525)) | **Cite only.** New removes Export. Confirm must not steal `#ask-export`. |
| T085 markdown render ([#526](https://github.com/Uuriko/project-room/pull/526)) | **Cite, do not rewrite.** Export writes source, not `innerHTML`. |
| T034 / T081 Artifacts-lite | **Cite only.** Collapse is after render; not an export field. |
| T047 empty canvas ([#268](https://github.com/Uuriko/dasha-lobby/pull/268)) | **Cite only.** Empty stays `What.` + ≤4 starters. No Export. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma stays draft. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform / no bonsai. No tip HTML. No wrangler. |

Paths this fold owns:

- `research/ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md` (this file)
- index rows on `research/README.md` and `docs/README.md` **next to
  the T044 / export / T045 receipt rows** (not the T085 markdown
  rows, not the T084 New-chat rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#275` rewrite · `#496`
T044 rewrite · `#526` T085 rewrite · `#525` New-chat rewrite.

---

## 3. Markdown download vs copy

Two verbs. Do not collapse them.

| Verb | Object | Destination | Confirm | Owner |
| --- | --- | --- | --- | --- |
| **Copy** | One `.ask-turn` | Clipboard | **Copied** | Ask v2 A3 · T082 **C** |
| **Export MD** | Whole `conversation[]` | File download `ask-transcript-YYYYMMDD.md` | **Saved** (or the browser download UI) | T044 chrome · **T086 format** |
| **Export JSON** | Whole `conversation[]` | File download `ask-transcript-YYYYMMDD.json` | **Saved** | T044 (`kind` `dasha.ask.transcript.v1`) |

Rules:

- Export is a **download**. It is not a second Copy of one bubble.
- Copy stays on the turn. Do not hang `#ask-export` on every
  `.ask-turn`.
- Do not flash **Copied** on Export. That word is A3.
- Whole-thread “copy as markdown” to the clipboard is **out of
  scope**. If a later task wants it, it is not this brief and not
  a replacement for the file.
- Mid-stream (`askBusy`): Export stays hidden or disabled (T044).
  Copy of a live turn stays A3’s problem, not a snapshot marked
  Done.
- Empty canvas (`!has-chat`): no Export, no Copy rail.

T085 reminder: MD file is **source** markdown from `conversation[]`.
Do not serialize `innerHTML` / `.ask-md`.

---

## 4. Headers that ship

### 4.1 Markdown header (always)

```md
# Ask transcript
- Engine: community
- Model: ternary-bonsai-2-27b
- Exported: 2026-09-18T…
```

| Line | Source | If unknown |
| --- | --- | --- |
| `# Ask transcript` | Fixed title | — |
| `Engine:` | Live engine select (`hosted` / `community` / `mixture` / `self`) | omit the value only if the control is missing — prefer the token `UNKNOWN` |
| `Model:` | Live `#ask-model` / select **raw id** | `UNKNOWN` |
| `Exported:` | Client clock, ISO-8601 | always write; do not invent a server time |

Speaker sections after the header:

```md
## You
…

## Mac
…
```

Labels match the thread (`You` / `Mac` / Hosted face) — not Room
member names. Fence assistant markdown as-is.

### 4.2 Model line

- Copy the live select id (`ternary-bonsai-2-27b`, …) or
  `UNKNOWN`.
- Speed / Mid / Quality is a **face** (T071 / T075). It is not
  the export model line. Raw id stays the field.
- Needle / `needle-3` is **not** a model line.
- gemma3-27b stays draft ([#258](https://github.com/Uuriko/dasha-lobby/pull/258)
  — do not undraft). If the live select is not that id, do not
  write it.

### 4.3 Receipt lines

T045 owns the **thread chip**. The file is not a second receipt.

| Line | Ships in MD header? | Ships in JSON? |
| --- | --- | --- |
| `Job:` / `job_id` | **Yes, only when** `lastPaidReceipt` has a job id | `job_id` string or `null` |
| Engine / Model | Yes (header; also JSON) | `engine` / `model` |
| tok/s / `tokens_per_second` | **No.** Measured speed stays on the T045 face | **No** on v1. T044 already forbade invented tok/s |
| Tokens / settled cents / `$` | **No.** | **No.** |
| Kit version / llama.cpp / Ollama | **No.** | **No.** |
| “Chained to the public receipt log.” | **No.** | **No.** |
| `room.receipt.v1` (`workItemId`, personas, `peopleData`, Cua) | **No.** | **No.** |
| Session tokens, emails, X handles, wallets | **No.** | **No.** |

MD Job line, only when present:

```md
- Job: job_abc123
```

If `lastPaidReceipt` is missing or has no id, **omit** the MD
line. Do not write `Job: null`. JSON still uses `job_id: null`.

Do not dump `#rcpt-raw` / expanded T045 fields into the file.
Honesty UNKNOWN is a chip face, not an export header.

---

## 5. JSON (cite T044, do not restyle)

```json
{
  "kind": "dasha.ask.transcript.v1",
  "exportedAt": "ISO-8601",
  "engine": "hosted|community|mixture|self",
  "model": "string|UNKNOWN",
  "job_id": "string|null",
  "turns": [
    { "role": "user|assistant", "content": "string", "state": "complete|stopped|error" }
  ]
}
```

T086 does not add fields. A later `tokens_per_second` is a
different task and stays `UNKNOWN` unless Compute measured it —
do not sneak it in on the same lobby PR as `#ask-export`.

---

## 6. Existing tip canaries (cite, do not rewrite)

| Canary (tip) | Locks | Why T086 cites it |
| --- | --- | --- |
| T044 [#496](https://github.com/Uuriko/project-room/pull/496) | Thread chrome; JSON/MD download; no empty-canvas Export | **Parent spec** |
| [#249](https://github.com/Uuriko/dasha-lobby/pull/249) `dasha-compute-ask-chat-ux-v2.test.mjs` | A3 Copy; A7 New clears `has-chat` | Copy ≠ Export; New drops Export |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** | Empty = `What.` + 4 starters | No Export dump on empty |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T030** | Hover-only actions; `#ask-model` whisper | Export is top-right, not a rail |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) | Chrome ≤15% | No toast stack / lecture |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** | No capacity dash | **Hands-off** |

Live `/compute` is still Typeform. T086 does not add a live fetch
and does not wrangler.

---

## 7. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Instinct tips quiet-shell live
**and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`:

- Keep T044 chrome. Write the T086 header bank. MD = download;
  Copy stays clipboard.
- Engine / Model / Exported always. Job only when
  `lastPaidReceipt` has an id. No tok/s header.
- Keep T047 / T030 / quiet-shell + ask-chat-ux v2 green.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275. Do not combine
  with T085 render, T084 New-chat, T082 keys, T083 battery, or
  T081 Artifacts in the same lobby PR.

This repository ships the brief only.

---

## 8. Acceptance checks

- [x] T086 is the Ask Export **thread format** brief, citing T044
      [#496](https://github.com/Uuriko/project-room/pull/496)
- [x] Names **markdown download vs copy** — MD is a file; Copy is
      clipboard; **Saved** ≠ **Copied**
- [x] Names headers that ship: Engine · Model · Exported
- [x] Model line is raw id or `UNKNOWN` — not Speed/Mid/Quality
      as the only line
- [x] Receipt line: **Job** only when `lastPaidReceipt` has
      `job_id`; omit on MD when null
- [x] No tok/s / kit / settle lecture / `room.receipt.v1` in the
      file header
- [x] JSON `kind` stays `dasha.ask.transcript.v1` (T044)
- [x] T045 / T046 cited; tok/s stays on the chip
- [x] T085 / #526 cited; export is source text; not rewritten
- [x] T084 / #525 cited; New removes Export
- [x] Quill #260 / #262 / #266 / #274 named; hands-off
- [x] dasha-lobby #275 T073 named; hands-off
- [x] #258 stays draft
- [x] Live Typeform / no bonsai named; no wrangler
- [x] Index rows sit next to T044 / T045, not T085 / T084
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
canary rewrite · T044 / [#496](https://github.com/Uuriko/project-room/pull/496)
chrome rewrite · T085 / [#526](https://github.com/Uuriko/project-room/pull/526)
markdown rewrite · T084 / [#525](https://github.com/Uuriko/project-room/pull/525)
New-chat rewrite · T082 / [#523](https://github.com/Uuriko/project-room/pull/523)
keyboard rewrite · T083 / [#524](https://github.com/Uuriko/project-room/pull/524)
battery rewrite · T081 / #521 Artifacts-lite rewrite · T033
implement · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Parent: T044 [#496](https://github.com/Uuriko/project-room/pull/496)
quiet export transcript.
Companion Copy: dasha-lobby #249 Ask v2 A3.
Companion receipt: T045 (tok/s stays on the chip).
Companion render: T085 (source, not HTML).
Companion canaries: #496 T044 · #249 v2 · #268 T047 · #270 T030 ·
#255 quiet-shell · #275 T073 (hands-off).*

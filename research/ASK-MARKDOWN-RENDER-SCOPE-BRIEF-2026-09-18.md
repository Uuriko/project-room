# T085 — Ask markdown render scope brief

18 September 2026. GFM subset brief. Docs only. Not a live Ask
HTML edit and not a dasha-lobby `renderAskMarkdown` rewrite.

**T085** — the **scope** of markdown inside `#ask-thread`. Tip
already paints a small GFM diet on **assistant** `.ask-said`.
T041 locked the canary. This note names **in vs plain** so a later
lobby PR does not invent full GFM, autolinks, or `<a>`.

Parents (cite only — do not rewrite):

- dasha-lobby [#269](https://github.com/Uuriko/dasha-lobby/pull/269)
  **T041** markdown render canary:
  `dasha-compute-ask-markdown-render-canary.test.mjs`
  (fences, lists, escape-only links)
- dasha-lobby [#249](https://github.com/Uuriko/dasha-lobby/pull/249)
  Ask chat UX v2 — stream-safe MD / incomplete fences

Companions (cite only):
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§5 stream-safe incomplete fences) ·
[ASK-ARTIFACTS-LITE-2026-09-18.md](ASK-ARTIFACTS-LITE-2026-09-18.md)
(T034 — collapse **closed** long fences after they already render) ·
[ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md](ASK-ARTIFACTS-LITE-IMPLEMENT-GATE-2026-09-18.md)
(T081 gate) ·
[ask/T034-artifacts-lite-ready-to-implement.md](ask/T034-artifacts-lite-ready-to-implement.md)
·
[ask/T044-quiet-export-transcript.md](ask/T044-quiet-export-transcript.md)
(MD export is source text, not a second renderer) ·
T086 format
([ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md](ASK-EXPORT-THREAD-FORMAT-BRIEF-2026-09-18.md)
— download vs copy; header / Job lines). Fold lock:
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md).

**Tip (source):** `Uuriko/dasha-lobby` `2e7778e6` — T073
[#275](https://github.com/Uuriko/dasha-lobby/pull/275) + Motley
[#272](https://github.com/Uuriko/dasha-lobby/pull/272). Includes
#246 / #249 / #255 quiet-shell + T041
[#269](https://github.com/Uuriko/dasha-lobby/pull/269) markdown
canary. **LIVE:** still Typeform / no bonsai until Instinct
wrangler. Instinct tipped.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

`#ask-thread` paints a **small GFM subset** on assistant turns:
**fences, lists, bold, inline code.** **Links stay plain.** User
turns stay `textContent`. No invented `<a>`.

---

## 1. Why this is not a T041 rewrite

[#269](https://github.com/Uuriko/dasha-lobby/pull/269) T041 already
owns the **canary**: helpers exist (`renderAskMarkdown` /
`askBlockMd` / `askInlineBits` / `escapeAskHtml` / `fillAskSaid`),
closed + stream-open fences, ul/ol, bold, inline code, and
**escape-only** links. It does not name the **product diet** —
what a later implementer must **not** grow.

| Existing spec | What it already owns | What it does **not** name |
| --- | --- | --- |
| Ask v2 [#249](https://github.com/Uuriko/dasha-lobby/pull/249) | Stream-safe MD; incomplete fences stay visible | In vs out GFM list |
| **T041** [#269](https://github.com/Uuriko/dasha-lobby/pull/269) | Source canary: fences / lists / escape-only links / XSS | The shipping subset as a brief. User-turn plain. Stay-plain table |
| Quiet-shell §5 | “markdown + stream-safe incomplete fences” | Which tokens render |
| T034 / T081 Artifacts-lite | Collapse **closed** fences > N lines | The renderer. Link policy |
| T044 export MD | Transcript file is source markdown | A second HTML renderer |
| **T085** | In vs plain. Assistant-only. No `<a>` | The canary. Fence collapse |

T041 still owns the test. T085 owns the **scope**. T034 still owns
collapse.

---

## 2. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T041 markdown canary ([#269](https://github.com/Uuriko/dasha-lobby/pull/269)) | **Cite only.** Same helpers. Do not rewrite the canary. |
| Ask v2 stream-safe MD ([#249](https://github.com/Uuriko/dasha-lobby/pull/249)) | **Cite only.** Do not restyle `.ask-md`. |
| T034 / T081 Artifacts-lite ([#493](https://github.com/Uuriko/project-room/pull/493) / [#507](https://github.com/Uuriko/project-room/pull/507) / [#521](https://github.com/Uuriko/project-room/pull/521)) | **Cite only.** Collapse is after render. Do not move N=16 here. |
| T044 export MD | **Cite only.** Export writes source, not `innerHTML`. |
| T082 keyboard ([#523](https://github.com/Uuriko/project-room/pull/523)) | **Cite only.** Fence Copy is T034, not this `C`. |
| T084 New chat / Clear thread ([#525](https://github.com/Uuriko/project-room/pull/525)) | **Merge separately.** Do not rewrite that brief. |
| T083 soft-battery ([#524](https://github.com/Uuriko/project-room/pull/524)) | **Cite, do not rewrite.** |
| T047 empty canvas ([#268](https://github.com/Uuriko/dasha-lobby/pull/268)) | **Cite only.** Empty `#ask-thread` has no MD chrome. |
| **T073** capacity-dash canary (dasha-lobby [#275](https://github.com/Uuriko/dasha-lobby/pull/275)) | **Hands-off.** |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) / [#262](https://github.com/Uuriko/dasha-lobby/pull/262) / [#266](https://github.com/Uuriko/dasha-lobby/pull/266) / [#274](https://github.com/Uuriko/dasha-lobby/pull/274) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** gemma stays draft. |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform / no bonsai. No tip HTML. No wrangler. |

Paths this fold owns:

- `research/ASK-MARKDOWN-RENDER-SCOPE-BRIEF-2026-09-18.md` (this file)
- `tests/ask-markdown-render-scope-docs.test.js`
- index rows on `research/README.md` and `docs/README.md` **next to
  the Artifacts-lite / T081 / stream-safe MD rows** (not the T084
  New-chat rows, not the T083 battery rows)

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML · `#262` / `#266` / `#274` Quill · `#275` rewrite · `#521`
Artifacts-lite rewrite · `#525` New-chat rewrite.

---

## 3. Who paints markdown

| Surface | Tip today | T085 |
| --- | --- | --- |
| Assistant `.ask-said` | `fillAskSaid` → `innerHTML = renderAskMarkdown(content, streaming)` · class `ask-md` | **The diet.** |
| User `.ask-said` | `<pre>` + `textContent` | **Stays plain.** Do not run GFM on the prompt. |
| Empty `#ask-thread` (`!has-chat`) | Hidden; T047 `What.` + ≤4 starters | **No MD chrome.** |
| Composer `#prompt` | Raw textarea | **Stays plain.** |
| `#ask-think` / run chip | One word | **Not markdown.** |

User markdown is visible as typed. Copy (A3) copies the turn’s
source / `.ask-said` text, not a second HTML tree.

---

## 4. Ships (GFM subset)

Tip helpers: `renderAskMarkdown` · `askBlockMd` · `askInlineBits` ·
`escapeAskHtml`. T041 already executes them in `vm`.

| Token | Tip | HTML |
| --- | --- | --- |
| Closed fence ` ```lang ` … ` ``` ` | `renderAskMarkdown` | `<pre><code class="language-lang">` · body escaped |
| Stream-open fence (no close yet) | `renderAskMarkdown(src, true)` | `<pre data-open="1"><code…>` · no raw ` ``` ` leak |
| Idle incomplete fence | `streaming === false` | Still a fence if closed; **no** `data-open` on a leftover open |
| Unordered list `- ` / `* ` | `askBlockMd` | `<ul><li>` |
| Ordered list `1. ` | `askBlockMd` | `<ol><li>` |
| Paragraphs + soft line breaks | `askBlockMd` | `<p>` · continued lines join with `<br>` |
| `**bold**` | `askInlineBits` | `<strong>` |
| `` `inline` `` | `askInlineBits` | `<code>` |

CSS already on tip (cite, do not restyle): `.ask-said.ask-md pre` ·
`ul` / `ol` · `code` · `strong`. Language class is a hook only —
syntax color only if tip already colors. T085 does not add a
highlighter.

Stream rule (already #249 / T041 / T034): **do not collapse** an
open fence. T034 N=16 applies to **closed** fences only.

---

## 5. Stays plain (do not grow)

The T041 title is “fences, lists, links.” **Links are the stay-plain
lock.** Source has **no** `[text](url)` renderer.

| Token | Tip today | Must stay |
| --- | --- | --- |
| `[docs](https://…)` | Literal text inside `<p>` | **No invented `<a>`** |
| Raw `https://…` | Literal text | **No autolink** |
| `<script>` / raw HTML | `escapeAskHtml` | Entities. Never `innerHTML` the raw string |
| Fence HTML (`<a onclick>`) | Escaped inside `<code>` | Still text |
| jup.ag mint / token URL | Text | **Never** `plugin.jup.ag` |
| `# heading` | Paragraph | No `<h1>`–`<h6>` |
| `> quote` | Paragraph | No `<blockquote>` |
| GFM table | Paragraph | No `<table>` |
| `![alt](src)` | Paragraph | No `<img>` |
| `*italic*` / `_em_` | Not in `askInlineBits` | No `<em>` |
| `~~strike~~` | Not in `askInlineBits` | No `<del>` |
| Task list `- [ ]` | Matches ul; `[ ]` stays text | No checkbox widget |
| Nested / indented lists | Not indent-aware | Flat ul/ol only |
| Reference links / footnotes | Paragraph | Stay text |
| Mermaid / HTML / SVG preview | — | XSS. Artifacts P1 skipped this |
| User turn | `textContent` | Stay `textContent` |

A later “full GFM” PR is a **different** task. It must not ride
T034 collapse, T044 export, or this brief. If links ever render,
they need a dedicated XSS + `plugin.jup.ag` review — not a drive-by
in `#ask-thread`.

---

## 6. Existing tip canaries (cite, do not rewrite)

| Canary (tip) | Locks | Why T085 cites it |
| --- | --- | --- |
| [#269](https://github.com/Uuriko/dasha-lobby/pull/269) **T041** `dasha-compute-ask-markdown-render-canary.test.mjs` | Fences (closed + `data-open="1"`), ul/ol, bold, inline code, `[text](url)` stays text, no `<a>`, XSS escaped, no `plugin.jup.ag` | **Parent canary** |
| [#249](https://github.com/Uuriko/dasha-lobby/pull/249) `dasha-compute-ask-chat-ux-v2.test.mjs` | Stream-safe MD | Helpers already ship in Ask v2 |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** | Empty = `What.` + 4 starters | No MD dump on empty |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) | Chrome ≤15% | No renderer toolbar |
| [#275](https://github.com/Uuriko/dasha-lobby/pull/275) **T073** | No capacity dash | **Hands-off** |

Live `/compute` is still Typeform. T041 default is source-only
(`LIVE_ASK_CANARY` off). T085 does not add a live fetch and does
not wrangler.

---

## 7. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Instinct tips quiet-shell live
**and** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`:

- Keep the T041 diet. Do not add a link renderer, autolink, table,
  heading, image, or italic pass in the same PR as T034 collapse.
- Keep T041 / Ask v2 / quiet-shell green.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch. Do not reopen #275. Do not combine
  with T084 New-chat (#525), T082 keys, T083 battery, or T081
  Artifacts in the same lobby PR.

This repository ships the brief only.

---

## 8. Acceptance checks

- [x] T085 is the Ask markdown **render scope** brief, citing T041
      tip canary [#269](https://github.com/Uuriko/dasha-lobby/pull/269)
- [x] Names the shipping subset: fences (closed + stream-open),
      lists (ul/ol), bold, inline code
- [x] Names **links stay plain** — no invented `<a>`, no autolink
- [x] User turns stay `textContent`; assistant `.ask-said` is the
      only `renderAskMarkdown` surface
- [x] Stay-plain table includes headings, tables, images, italic,
      strike, mermaid / HTML preview
- [x] Never `plugin.jup.ag`
- [x] T034 / T081 collapse cited; not rewritten
- [x] Quill #260 / #262 / #266 / #274 named; hands-off
- [x] dasha-lobby #275 T073 named; hands-off
- [x] #258 stays draft
- [x] T084 / #525 named; merge separately
- [x] Live Typeform / no bonsai named; no wrangler
- [x] Index rows sit next to Artifacts-lite / T081, not T084 / T083
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
canary rewrite · T041 canary rewrite · T084 /
[#525](https://github.com/Uuriko/project-room/pull/525) New-chat
rewrite · T082 / [#523](https://github.com/Uuriko/project-room/pull/523)
keyboard rewrite · T083 / [#524](https://github.com/Uuriko/project-room/pull/524)
battery rewrite · T081 / #521 Artifacts-lite rewrite · T033
implement · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Parent: dasha-lobby #269 T041
`dasha-compute-ask-markdown-render-canary.test.mjs`.
Companion stream-safe MD: dasha-lobby #249 Ask v2.
Companion collapse: T034 / T081.
Companion canaries: dasha-lobby #269 T041 · #249 v2 · #268 T047 ·
#255 quiet-shell · #275 T073 (hands-off).*

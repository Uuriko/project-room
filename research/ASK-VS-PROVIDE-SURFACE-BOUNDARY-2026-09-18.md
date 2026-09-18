# T074 — Ask vs Provide surface boundary

18 September 2026. Research / spec note. Docs only. Not a live Ask
HTML edit and not a dasha-lobby canary rewrite.

**T074** — Ask never hosts Provide doors, Host marketplace chrome, a
capacity dashboard, or a providers table on the empty Ask canvas or
the Ask thread. Those surfaces stay on Provide / Compute chrome.

Companions (cite only):
[ASK-QUIET-SHELL-V3.md](../docs/ASK-QUIET-SHELL-V3.md)
(§3.1 one primary · §3.5 empty state · §7 item 11) ·
[ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md](ASK-LADDER-ADVANCED-AND-NETWORK-HONESTY-2026-09-18.md)
(T071 grouping · T072 one expandable `N Macs · models` line) ·
[ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md](ASK-RECEIPT-LASTPAID-WHISPER-BRIEF-2026-09-18.md)
(T087 — `#ask-receipt` Job whisper; never a capacity dash) ·
[UX-CLEAN-LESS-NOISE-2026-09-17.md](UX-CLEAN-LESS-NOISE-2026-09-17.md)
(Ask P0 empty · Provide P1 secondary) ·
[FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md)
(Compute ≠ Room). Fold lock stays.

Product personal agent (Room) is **Second**. Never Genie. Ask is
Compute’s chat door. Compute ≠ Room.

---

## 0. One line

Ask is a thread. Provide / Host / Marketplace / capacity / providers
are other doors. The empty Ask canvas and the Ask thread never host
them.

---

## 1. Collision lock

| Parallel fold | This note does |
| --- | --- |
| T047 empty-canvas canary (dasha-lobby [#268](https://github.com/Uuriko/dasha-lobby/pull/268)) | **Cite only.** Do not rewrite `dasha-compute-ask-empty-canvas-canary.test.mjs`. |
| T027–T030 quiet-shell canaries (dasha-lobby [#270](https://github.com/Uuriko/dasha-lobby/pull/270)) | **Cite only.** Do not rewrite `dasha-compute-ask-quiet-chrome-canary.test.mjs`. |
| T050 Community-chip canary (dasha-lobby [#269](https://github.com/Uuriko/dasha-lobby/pull/269)) | **Cite only.** No Community dump on empty `#ask-scroll`. |
| T071 / T072 ladder + network line ([#518](https://github.com/Uuriko/project-room/pull/518)) | **Cite only.** T072 is one expandable honesty line, not this boundary rewrite. |
| **T073** no-capacity-dash canary on dasha-lobby | **Spinning. Hands-off.** Tests-only canary there. Do not open a second T073 PR. Do not write dasha-lobby HTML or tests here. |
| dasha-lobby [#260](https://github.com/Uuriko/dasha-lobby/pull/260) | **Quill owns** `dasha-compute.html` + embed. Hands-off. |
| dasha-lobby [#258](https://github.com/Uuriko/dasha-lobby/pull/258) | **Cite, do not edit / undraft.** |
| Instinct wrangler | **Red.** Live `/compute` is still Typeform. No tip HTML. No wrangler. |
| T032 / T033 ⌘K implement | **Cite only.** |
| T068 / T069 battery / Prefer AC | **Not** this path. Provide operator copy stays on Provide. |
| T083 soft-battery UX copy | **Cite only.** Runtime `On battery · paused`. Never block Ask. |

Paths this fold owns:

- `research/ASK-VS-PROVIDE-SURFACE-BOUNDARY-2026-09-18.md` (this file)
- `tests/ask-provide-surface-boundary-docs.test.js`
- index rows on `research/README.md` and `docs/README.md`

No `client/` · `cloudflare/` · `server/` · `src/` · Worker · wrangler
· Designer · people-data · `plugin.jup.ag` · Quill login · Potter
keys · dasha-lobby HTML / Worker / tests · `#258` undraft · `#260`
HTML.

---

## 2. Two products, four surfaces Ask must not host

Ask and Provide share a Compute site. They do not share a first
paint.

| Surface | Job | Where it lives | On empty Ask canvas / thread? |
| --- | --- | --- | --- |
| **Ask** | Chat. `#step-ask` thread + sticky composer. | `/compute` Ask door | **This** surface. Greeting + ≤4 starters. Then the thread. |
| **Provide doors** | Register / Setup a Mac. `#ask-provide` | Composer `#ask-nav` (quiet). Hidden once `body.has-chat`. | **Never.** |
| **Host marketplace chrome** | Host + OpenClaw Marketplace. `#ask-host` · `#ask-ocm` | Same quiet nav. More stays closed. | **Never.** |
| **Capacity dashboard** | Fleet / Mac / tok/s / kit / RAM grid | Provide / Compute chrome — not Ask | **Never.** T072 is one line. T073 canaries the ban on dasha-lobby. |
| **Providers table** | Named Macs, measured rows, market table | Provide / market / honesty expand — not Ask thread | **Never.** Expand of T072 stays one panel of advertised ids, not a table of hosts. |

Start. is Ask / Provide / Pay / Credits as **separate** doors
([FOLD-COMPUTE-ROOM.md](../docs/FOLD-COMPUTE-ROOM.md)). Ask first
paint is already chat. It does not sell the rest of Compute.

---

## 3. Empty canvas and thread (what “never hosts” means)

### 3.1 Empty Ask (`#ask-scroll` without `has-chat`)

Allowed:

- One greeting line (`#ask-greet` → `What.`)
- At most four starter chips (`#ask-starters`)
- Hidden empty `#ask-thread`
- Sticky composer (`#ask-composer` · `#ask-input` · `#ask-send`)
- Quiet `#ask-model` whisper pill **inside** the composer (T030)

Forbidden on that canvas and on the empty thread:

- `#ask-provide` / `#ask-host` / `#ask-ocm` (or `>Provide<` /
  `>Host<` / `>Marketplace<` ink)
- Door-row / Typeform `Start.` / `Do.` H1s
- Capacity dashboard (Mac grid, kit version, RAM lecture, tok/s
  essay, “N providers” table)
- Providers table / Community Macs dump / `#ask-community` ink
- Copy-AI-skill CTA (`#copy-skill-use`)
- Speed / Mid / Quality chips as empty-state starters (T071)

Those Provide / Host / Marketplace ids may exist in composer
`#ask-nav`. They are **not** canvas children. `body.has-chat
#ask-nav` hides them once a thread exists. `#ask-more` starts
closed.

### 3.2 Ask thread (`body.has-chat`)

The thread is turns. It still does not host:

- Provide / Host / Marketplace doors
- A capacity dashboard
- A providers table

Network honesty, if present at all in Ask chrome, is T072: one
expandable `N Macs · models` line on `#honesty-panel` / `#top-state`
— **not** on `#ask-scroll`, **not** mid-stream (T046), **not** a
receipt (T045). Pending is `…`. Unmeasured is `UNKNOWN` or omitted.

---

## 4. Existing dasha-lobby tip canaries (cite, do not rewrite)

Quiet-shell and empty-canvas locks already live on
`Uuriko/dasha-lobby` **tip** (source on main; live `/compute` still
Typeform until Instinct wrangler). T074 points at them. It does not
re-open those PRs and does not add HTML.

| Canary (tip) | Locks | Why T074 cites it |
| --- | --- | --- |
| [#255](https://github.com/Uuriko/dasha-lobby/pull/255) quiet-shell polish + `dasha-compute-ask-quiet-shell.test.mjs` | Chrome ≤15%. Thread + composer. No Typeform first paint in **source**. | Parent shell. Boundary sits on this paint. |
| [#268](https://github.com/Uuriko/dasha-lobby/pull/268) **T047** `dasha-compute-ask-empty-canvas-canary.test.mjs` | Empty `#ask-scroll` = `What.` + 4 starters. `#ask-provide` / `#ask-host` / `#ask-ocm` **not** on canvas or empty `#ask-thread`. Those ids live in composer `#ask-nav`. `body.has-chat #ask-nav` hides them. | **Provide / Host / Marketplace doors stay off Ask.** |
| [#270](https://github.com/Uuriko/dasha-lobby/pull/270) **T027–T030** `dasha-compute-ask-quiet-chrome-canary.test.mjs` | ≤4 starters; hover Copy/Regen/Edit; `Thinking…` + Stop; `#ask-model` whisper pill in composer, not on the empty canvas | Quiet-shell density. No extra door chrome to “fill” the empty state. |
| [#269](https://github.com/Uuriko/dasha-lobby/pull/269) **T050** `dasha-compute-ask-community-chip-canary.test.mjs` | Empty `#ask-scroll` has no Community ink / no `#ask-community` dump. `#change-engine` is one quiet `Community` word in the composer | No providers dump disguised as a Community chip. |
| [#271](https://github.com/Uuriko/dasha-lobby/pull/271) **T031 / T038 / T046** `dasha-compute-ask-quiet-leftover-canary.test.mjs` | Leftover `Start.` / `Do.` + mid-stream tok/s chrome stay off Ask source | Door-row / lecture leftovers do not return. |
| **T073** (spinning on dasha-lobby, tests-only) | No capacity dashboard on Ask | **Do not collide.** Cite as the canary that will lock the dash ban in Worker source. This note is the project-room boundary; that PR is the lobby test. |

Disk == embed == `worker.fetch('/compute')` on those tip files.
Optional `LIVE_ASK_CANARY=1` fails honestly while live is Typeform.
Default off. T074 does not add a live fetch.

---

## 5. Where Provide chrome *does* belong

Not deleted. Relocated.

| Chrome | Home |
| --- | --- |
| Provide Register → Setup | Provide door / `#ask-provide` in `#ask-nav` only |
| Host / Marketplace | `#ask-host` / `#ask-ocm` in `#ask-nav`; More closed |
| Capacity / fleet honesty | Compute `#honesty-panel` — T072 one line; expand is ids + measured tok/s |
| Providers / market table | Provide / market surfaces (`dasha-compute-market-table` and cousins). Not `#ask-thread` |
| Battery / Prefer AC / 24GB soft floor | Provide operator docs (T068 / T069 / T060 · T083 runtime `On battery · paused`). Not Ask canvas lecture. T083: never block Ask |

Ask may **link** to Provide. It may not **paint** Provide.

---

## 6. Implement later (not this repo)

On `Uuriko/dasha-lobby` **after** Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
is off `dasha-compute.html` / `dasha-compute-page.mjs`, and only if a
tip canary is still missing a selector:

- Keep T047 / T027–T030 / T050 green.
- Let **T073** (already spinning) lock: no capacity dash / no
  providers table on `#ask-scroll` or `#ask-thread`.
- Do not wrangler from project-room. Do not undraft #258. Do not
  touch Quill’s HTML branch.

This repository ships the boundary only.

---

## 7. Acceptance checks

- [x] T074 states Ask never hosts Provide doors, Host marketplace
      chrome, a capacity dashboard, or a providers table on the empty
      Ask canvas / thread
- [x] Cites tip empty-canvas + quiet-shell canaries: #268 T047,
      #270 T027–T030, #255 quiet-shell, #269 T050, #271 leftovers
- [x] Names the canary files on dasha-lobby tip; does not rewrite them
- [x] T073 named as spinning dasha-lobby tests-only canary; no
      collide
- [x] Quill #260 named as HTML blocker; hands-off
- [x] No dasha-lobby HTML, no wrangler, no Worker, no people-data,
      no Designer, no Potter keys
- [x] Needle not added as Ask chrome
- [x] Second, never Genie

---

## 8. Stay-outs

Quill login · Quill [#260](https://github.com/Uuriko/dasha-lobby/pull/260)
compute HTML · Muse UI / paper faces · Instinct Phase 0 #8 / #9 ·
Designer-publish · people-data · `plugin.jup.ag` · **direct wrangler**
· dasha-lobby HTML / Worker / tests · dasha-lobby
[#258](https://github.com/Uuriko/dasha-lobby/pull/258) undraft ·
T073 canary PR · T033 implement · Ask regen / Continue (T042 / T043)
· Artifacts-lite · listing Needle as chat · calling Second a Genie ·
`client/` `cloudflare/` `server/` `src/` `deploy/` in this fold.

---

*End. Parent: quiet-shell “no dumping Provide / Host / Marketplace
into Ask empty state.” Companion canaries: dasha-lobby #268 T047 ·
#270 T027–T030 · #255 · #269 T050 · #271 leftovers. Companion
honesty line: T072. Companion dash canary (lobby, spinning): T073.*

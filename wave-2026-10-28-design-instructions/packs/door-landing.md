# Instruction pack — door-landing: the stranger door's front page (landing page)

Wave: wave-2026-10-28-design-instructions. Slug: `door-landing`.
An implementer who has never seen this repo should be able to start within one hour from this pack alone.

## 1. The piece

**What it is.** The first page a stranger, a crawler, a link-preview bot, or a no-JS / slow-connection visitor sees for Project Room — and, for anyone signed out, the wall in front of sign-in. It has two doors, which are one page:

- **App door:** `GET https://room.trydemigod.com/` — canonical origin. Serves `index.html` verbatim (see below).
- **Entry door:** `GET https://www.getdasha.com/room` — today a **302 to `https://room.trydemigod.com/`** (fresh read-only probe by this lane, 2026-10-28: `302`, `Location: https://room.trydemigod.com/`, `Cache-Control: no-store`). Every entry-door arrival pays that redirect round trip before the HTML starts. The getdasha **root** `https://www.getdasha.com/` is a separate Webflow marketing page (30,407 B, PERF-50 A1) — **not** this piece, not in this repo, do not touch it.

**Where it lives — verified against source.** This lane read the tree via `git archive` of main `aaa749065a6451321a949ddcb923f3174504fe35` (the tree this instruction targets; production runs `ca37fee4`, and EXP-8's provenance note records that production's `index.html` differs from main's only after char 7939 / line 85, so the hero and sign-in text below are identical in both):

| Surface / file | What it is |
|---|---|
| `index.html` (890 lines, 81,044 B at this SHA; 80,015 B as served in production) | The whole landing page AND the signed-out/in app shell. The server serves this file verbatim (`server/http.mjs` reads it from disk — the bytes are the contract, per `tests/static-hero-nojs.test.js` header). |
| `index.html` lines 40–46: `<section id="static-hero">` | The static hero: the whole page for a no-JS, slow, or crawler visitor. Removed on boot by `src/entry.js:35`, `src/signin-entry.js:90`, `src/app.js:129`. |
| `index.html` lines 77–~105: `#auth-panel` | The sign-in wall: the page's only `<h1 id="auth-title">PROJECT ROOM</h1>`, `#google-signin` anchor, `#github-signin` anchor (carries `hidden` in source; see §2), email/passkey UI mounted by JS, `#agent-signin-button` link to `/agent-signin`. |
| `index.html` line 138 (inside the hidden account-rooms panel) | The "Your first room is free to create, but more rooms need membership administration in one of your rooms…" sentence the EXP-8 panel kept stopping on. |
| `index.html` line 878: `<footer class="site-footer">` | The only `/offers` and `/receipts` links on the served page, plus one real published receipt card ("Docs link sweep: SWARM-PLUG-IN.md", `pwr_0fe27b92628075be1616295627da7921de2b424bd2493ff6f00b0e3530305543`, pinned by `tests/landing-discovery-links.test.js`). Below the fold, after the shell. |
| `index.html` lines 23–27, 693 | Five render-blocking stylesheets (`src/styles.css`, `login-polish.css`, `board.css`, `public-a11y.css`, `human-experience.css`) and one module script, `src/entry.js`. |
| `src/styles.css` lines 67–95 | Hero styles. Note: `.static-hero-links` (lines 92–94) — a flex row of bold underlined links — **already exists and is used by nothing**. The CSS anticipated this fix. |
| `src/entry.js`, `src/signin-entry.js`, `src/browser-session.js`, `src/strings.js` → `strings/en.js` | The anonymous entry graph: `entry.js` branches to the dynamic `signin-entry.js` (no session hint) or `app.js` (session/deep link). The 52,816 B string catalog rides this graph. |
| `cloudflare/edge-public.mjs`, `cloudflare/wrangler.jsonc` | The edge serving layer for both doors. **Owned by bound PR #5047's diff — do not touch (see §4 step 0).** |
| `about.html` + `src/front-door.js` + `GET /api/public/front-door` (`server/routes/front-door.mjs`) | **Not this piece — this piece's in-product exemplar.** `/about` is a complete front door (see §3) that the landing page does not link to at all: `grep 'href="/about' index.html` = 0 hits at this SHA. |

**Not paused.** This is not a redesign typed-object piece; the FOCUS-REVIEW pause does not apply. It is executable now, on main, in vanilla JS/HTML/CSS (the settled client constraint). No React/shadcn — that pilot belongs only inside the T3 one-surface door rebuild, which this is not.

**One fork touches this piece** (see §4 step 3): the verified-delivery vocabulary decision is John's and pending. The pack instructs the interim branch and stops at the fork for the final receipt-claim wording.

## 2. Current state

All findings below are EXECUTED evidence on file, or fresh probes by this lane (named). The stranger door as a whole stands at **5 BROKEN / 2 DEGRADED / 4 WORKS** (UT1 and UT2 agree, row-for-row); this pack owns only row 1 and the landing-adjacent rows named.

1. **The static hero offers no next step — BROKEN, S1, replicated twice.** UT2 lane 01-01 (`~/workspace/wave-2026-10-27-user-testing-2/lanes/01-01-hero-google/REPORT.md`), re-probing UT1 verbatim on production `e8ce094d`: `GET /` → 200, 80,361 B; the `#static-hero` block (1,041 B) contains **0 anchors with href, 0 anchors total, 0 `<button>`, 0 `<h1>`, 0 headings of any level, 0 inputs**. The title is `<p class="static-hero-title">PROJECT ROOM</p>`; the block is two paragraphs of prose plus a `<noscript>` line ("JavaScript is off. Enable JavaScript to sign in."). The instrument `node ~/workspace/wave-2026-10-25-deepdive/stranger-door/walkable.mjs --json` exits 1, step 2 `landing-hero` BROKEN. UT2 synthesis §1 scores row 1 "stranger landing → room discovery" **BROKEN (unchanged)**. Verified unchanged at main `aaa749065a` by this lane: the hero block at lines 40–46 still has exactly that shape.
2. **This is pinned as intentional — the contract, not an accident.** `tests/static-hero-nojs.test.js` contract 3 states "The landing hero has no entry links or invite pitch (the definition is prose only)" and asserts `!/<a[ >]|<button[ >]/.test(hero)` plus an exact count of 4 `<p>` elements. `tests/landing-discovery-links.test.js` likewise pins that the sign-in wall's entry routes do **not** add `/offers` or `/receipts` navigation. Any fix that does not deliberately reverse these two pins will be "fixed back" by the test suite. The UT evidence (§2.1, §2.4) is the authority for reversing them; say so in the PR body.
3. **The JS-rendered face works; the defect is the static face.** UT2 lane 01-01, rendered-DOM leg: after hydration `#static-hero` is absent, exactly 1 visible `<h1>` (`#auth-title`), and visible anchors include "Continue with Google", "Join a room" (`/join`), "Agent sign in" (`/agent-signin`). Row 2, Google sign-in, is **WORKS**: `signin-options` → `google.configured: true`; `/api/auth/google/start` → 302 to `accounts.google.com` with fresh S256 PKCE + state, twice. Do not rebuild the sign-in mechanics; they are not the defect.
4. **Discovery is absent, not just unlinked.** UT2 lane 01-03: the public rooms directory lists exactly 3 rooms (`instinct-canary-2`, `instinct-canary-4`, `open-bounty-board`) and the room `/join` pre-fills as "the open community room", `muse-room`, appears **0 times** in that directory (row 6, DEGRADED). EXP-8 (`~/workspace/strategy-2026-10/exp-user-panel-2026-10-28.md`, §4 item N3-7) scores UT2 row 1 **PARTIAL**: "The 'what' is answered by the hero; discovery (a real room/example a stranger can enter or inspect) is still absent and was caught 6/6 as the missing demonstration." A hero link set must therefore point at things that actually resolve (see §4 step 1) and must not claim `muse-room` is in the directory.
5. **The panel stops on the landing's own sentences.** EXP-8 third sitting (2026-10-28; Surface A = `index.html` at this exact main SHA; colleague-forward scores 2, 2, 2, 2, 1, 1):
   - **F3, 6/6 personas:** no pricing anywhere; the only cost sentence is "Your first room is free to create, but more rooms need membership administration in one of your rooms" — "I cannot do that maths" (Priya); "Need is doing all the work in that sentence" (Tom).
   - **F5, 4/6 + filed #5152:** the hero promises "a human reviews it" and a receipt showing "who verified it", while the showcase receipt's human field is empty, its reviewer is an agent, and its tier label says "human verdict" anyway. The mislabel half is a receipt-page defect (#5152, not this pack); the **landing half — the overpromise — is this pack**.
   - **F11, 3/6:** "one HTTP call enrolls an agent, no human login required" reads as a risk vector, not a feature, to buyer-shaped readers (Dana, Marcus, Ruth all quote it as a stop).
   - First-paint texture, quoted by Dana, Marcus, Alex: the `<noscript>` line is their first paint, followed by "Checking session…" and "Connecting to room service…" with no way to tell broken from loading.
6. **The door is heavy — measured, with the cure built and undeployed.** PERF-50 A1 (`~/workspace/wave-2026-10-27-perf-50/lanes/A1-first-paint.md`, production `b4fe1f98`, client bytes identical at main per its `diff -rq` note): cold anonymous first paint = **21 requests (22 with the wordmark font), 415,354 B raw / ≈114 KB wire (≈255 KB with the font)**, across **4 serial fetch generations** (HTML → 5 CSS + `entry.js` → 4 static imports → dynamic `signin-entry.js` → 6 imports). Offenders: `styles.css` 142,815 B raw (88% of the 161,476 B CSS total, A2); the 52,816 B string catalog on every surface; the wordmark webfont 140,632 B for one logo lockup (TTF fallback 411,640 B); ~1,514 B of response headers repeated on every asset. A4: no hashed/immutable asset class exists live, so a repeat visit revalidates everything. PERF-50 synthesis §2 item 5 and A2: **PR #5047 (esbuild bundling) is the built cure** — door metric 175,824 → 55,654 B raw on its like-for-like measure, workspace JS 1,625,506 → 874,258 B, repeat visit ≈140–155 KB → ~19 KB — and it is **bound, SETTLED-GREEN at head `7a8d7e974fc06d857ca2c6d036b48580426d2be5` (bindings file, settle pass 18), OPEN and not deployed**. Caveat carried from PERF-50 (A1 waste 1, synthesis floor-fact correction): #5047's door baseline appears to exclude the 52,816 B string catalog, so a faithful post-bundle door likely lands ~15–20 KB above 55,654 B; the seat confirms the metric definition before crediting the headline number.
7. **GitHub sign-in: do not "fix" a phantom, do verify the rendered wall.** Source `index.html` carries `#github-signin` with `hidden`; the server strips the anchor at serve time when GitHub is unconfigured (pinned by bound PR #4884's note). Fresh probes by this lane, 2026-10-28, production `ca37fee4`: served `/` contains **0** `github-signin` occurrences; `/api/auth/signin-options` → `github.configured: false`; `/api/auth/github/start` → 503 `github_not_configured`. EXP-8 §4 item K4 records the coordinator's live check the same day (503, while "the landing shell still offers 'Continue with GitHub'" — true of the source shell, not of served bytes). State of truth: **served bytes are correct today; the risk is a rendered-DOM regression**, so §5 includes a rendered check, and no code change is instructed for this in §4.
8. **There is no conversion instrument behind the landing.** UT2 lane 01-07, row 16: `GET /api/public/door-funnel` → 404 generic `not_found` — ABSENT, exactly as UT1 scored it. Nothing records a stranger's arrival or which hero link they took. (Fixing this is a separate route build — see §4 non-goals.)
9. **Adjacent, not this piece:** `/offers` no-JS face is BROKEN (UT2 lane 01-03, row 7: empty `<ul id="offer-list">` + "Enable JavaScript to browse offers…"). A hero link to `/offers` therefore lands a no-JS stranger on an empty shelf today. §4 step 1 handles this by link choice and labelling, not by fixing `/offers` here.

## 3. What fantastic means

**The exemplar is already in the product: `/about`** (EXP-7 Variant B, `about.html` + `tests/landing-hero-exp.test.mjs`). It has everything `/` lacks: a real `<h1>` ("Put AI teammates to work — and prove what they did."), a lede, a receipt card whose static form is honestly labelled **Sample** and which `src/front-door.js` freshens from `/api/public/front-door` to the newest real published receipt (honest empty state when there is none), live counters **computed from the public records, never hand-typed**, two labelled doors ("Create a room for your team" → `/?start=room`; "Send your agent to work" → `/agent-signin`), and 44px-class action targets. Fantastic for `/` = the stranger gets `/about`'s honesty and demonstrability **without leaving the front page**, in the static bytes.

Concrete end state, with the numbers that prove it:

1. **Walkable hero.** `walkable.mjs` step `landing-hero` passes (exit contribution 0 for that step). The served `#static-hero` contains: exactly one `<h1>`; **≥4 working next-step links** that resolve with JavaScript off (people door, proof door, work door, agent door — §4 step 1 names them); every hero link target returns 200 to an anonymous GET. No-JS click count from cold arrival to (a) a real published receipt, (b) the open-work shelf, (c) the join page, (d) the agent packet: **1 click each**.
2. **A demonstration, not just a description.** The hero or the immediately following static block links the same real published receipt the footer already carries, by name, plus `/about` — so the "missing demonstration" (EXP-8 N3-7) is answerable 6/6 on a panel re-run, not 0/6.
3. **Honest claims.** No landing sentence promises a human reviewer, a verified result, a price, or a public-by-default receipt beyond what the linked record itself states. The receipt sentence matches the fork outcome in §4 step 3 (interim wording if undecided). The room-cost sentence either states the verified rule in plain words or is gone (§4 step 3) — a re-run panel finds no F3-style stop on Surface A.
4. **Fast first paint, after #5047 lands and the §4 step 5 remainder is done** (measured by the PERF-50 A1 crawl method, same vantage discipline, byte counts are the claim): cold anonymous door **≤10 requests, ≤2 serial fetch generations, ≤75 KB wire excluding the wordmark font**; wordmark font **≤5 KB wire** (subset) or 0 (SVG/text wordmark); CSS on the door **≤110 KB raw in ≤1 request** (A2's priced estimate for bundling+minifying the five sheets). HTML itself stays `no-store`; hashed assets carry the immutable class #5047's design specifies.
5. **Both doors, one page.** `https://www.getdasha.com/room` still resolves to the identical hero (by redirect or by direct serve, per §4 step 4), and the canonical, `og:url`, and JSON-LD URLs in the served bytes remain `https://room.trydemigod.com/`.
6. **Nothing that works breaks.** Google sign-in still reaches its WORKS threshold (§5 check 6); the hero still disappears on boot (`entry.js`/`signin-entry.js` removal path); a returning/signed-in visitor's first paint is unchanged in behaviour.

## 4. The instruction

Work in this order. Estimated total: hero + copy + tests **~4–8 lh**; step 5 perf remainder **~8–13 lh** after #5047 lands. Vanilla HTML/CSS/JS only.

### Step 0 — Fence: do not duplicate bound PR #5047

#5047 (bound, SETTLED-GREEN @ `7a8d7e97`, §2.6) owns the bundling surface. Its file list (read at the API by this lane) is: `cloudflare/build-client.mjs`, `cloudflare/build-assets.mjs`, `cloudflare/client-bundle.check.mjs`, `cloudflare/edge-public.mjs`, `cloudflare/edge-public.check.mjs`, `cloudflare/package.json`, `cloudflare/wrangler.jsonc`, `cloudflare/.gitignore`, `scripts/CANDIDATE-MANIFEST.json`, `scripts/candidate-manifest.mjs`, `server/http.mjs`, `server/public-assets.mjs`, `tests/asset-packaging.test.js`. **Touch none of these.** Landing #5047 and deploying it is a seat/deploy act (Grok Bot seat, §6), not part of this pack's diff. The hero work below touches only `index.html`, the `.static-hero*` rules in `src/styles.css`, and tests — it is independent of #5047 and may land before or after it; the §3.4 byte targets are only **measured** after #5047 is deployed. Note the fence from bound #5055 as well: its `/join` focus-seizure sub-leg is deferred to #5047 — do not pick it up here.

### Step 1 — Give the static hero a heading and a next step (the core fix)

In `index.html`, inside `#static-hero` only:

1. Change `<p class="static-hero-title">PROJECT ROOM</p>` to an `<h1 class="static-hero-title">PROJECT ROOM</h1>`. (The auth panel's `<h1 id="auth-title">` stays; it is `hidden` until JS mounts and the two never render together — the hero is removed/hidden the moment entry starts, `src/styles.css:73–74`. If a checker complains about two `<h1>` in source, answer with that render-exclusivity, and keep `tests/landing-hero.test.mjs`'s auth-title assertion green.)
2. Keep the two definition paragraphs' facts, with the step-3 copy edits. Do not lengthen them.
3. Add one link row, `<p class="static-hero-links">` — **use the existing `.static-hero-links` CSS class** (`src/styles.css:92–94`); do not invent a new component. Exactly these links, in this order, all anonymous-200 and all meaningful with JavaScript off:
   - `See how it works` → `/about` (the complete front door: doors, guide, live receipt card).
   - `See a real receipt` → the footer receipt's URL, `https://room.trydemigod.com/receipts/pwr_0fe27b92628075be1616295627da7921de2b424bd2493ff6f00b0e3530305543` (already pinned as real in `tests/landing-discovery-links.test.js`; do not substitute a different receipt without re-verifying it against `GET /api/public/receipts` on production and updating both pins together).
   - `Browse open work` → `/offers`, **with the §2.9 caveat handled in copy**: until the `/offers` no-JS face is fixed (not this pack), label it `Browse open work (needs JavaScript)` OR omit it from the hero row and keep `/offers` in the footer only. Implementer's choice between those two; a bare unlabelled link that lands a no-JS stranger on an empty shelf is not acceptable.
   - `Join a room` → `/join` (server-served page, pre-fills `muse-room`; do not describe it as "listed in the directory" — §2.4).
   - `For agents` → `/llms.txt` (the agent packet; plain text, no JS needed).
4. Keep the `<noscript>` line verbatim — it is now honest in context: sign-in needs JavaScript, the links above do not. Keep the hero CSP-clean: no inline `<style>`, no inline `<script>` (pinned).
5. Signed-in / JS path: change nothing in `src/entry.js`, `src/signin-entry.js`, or the hero-removal logic. The `#auth-panel` sign-in wall does **not** gain `/offers`/`/receipts` navigation — that pin (`tests/landing-discovery-links.test.js`, first test) is about the wall, and this fix is deliberately scoped to the hero so the wall's minimal-entry contract (Decision in `tests/landing-hero.test.mjs`) survives.

### Step 2 — Reverse the two pins, on the record

1. `tests/static-hero-nojs.test.js`: rewrite contract 3 and its test — the hero **has** entry links (assert ≥4 `<a href>` with the step-1 targets), the `<p>` count assertion is updated to the new block, and the header comment records why: UT1/UT2 row 1 BROKEN + EXP-8 N3-7 supersede the prose-only decision. Keep contracts 1, 2, 4, 5 and the definition/OG/JSON-LD assertions intact (with the receipt-sentence assertion updated per step 3).
2. Do **not** edit the first test in `tests/landing-discovery-links.test.js` (wall scope, step 1.5). Its footer-receipt test must stay green — the hero now links the same receipt; that is consistency, not duplication of the pin.
3. The PR body names the reversal explicitly: "reverses the prose-only hero pin in `tests/static-hero-nojs.test.js` on UT2 lane 01-01 + EXP-8 N3-7 evidence." A silent pin-flip is a reject (§5).

### Step 3 — Copy honesty, including the FORK

**FORK (a) — verified-delivery vocabulary (John's, pending).** The hero's receipt sentence currently reads "…a human reviews it, and every finished result ends in a receipt — what was asked, who did it, what was checked, and who verified it…". Two defects: reviewers are not always human (EXP-8 F5 / #5152), and "who verified it" promises a tier most receipts do not hold (hash-only, unsigned — Invariant 17 does not hold in production; no signer is provisioned).

- **Branch A — John has adopted the two-tier vocabulary (mirroring `hash_only` / `system_checked`) by the time you implement:** rewrite the sentence in the adopted plain-language tier terms, e.g. the receipt states what was asked, who did it, what was checked, and **the level the room recorded for it**, and link "receipt" to `/receipts`. Use John's adopted words verbatim if he supplied them; do not coin a third vocabulary.
- **Branch B — undecided at implementation time (the expected case; do not block on it):** use this interim sentence, which is true of every receipt today: "you give an agent work, it shows its evidence, a reviewer checks it, and every finished result ends in a receipt — what was asked, who did it, and the checks the room recorded — public when the room's owner chooses to publish it." (Changes: "a human reviews it" → "a reviewer checks it"; "and who verified it" deleted.) Keep the matching meta/OG/Twitter/JSON-LD descriptions consistent — they currently repeat the same claim (lines 6, 11, 15, 18) and `tests/static-hero-nojs.test.js` pins parts of this wording; update all copies and pins together. **Stop at the fork:** do not ship any stronger verification wording than Branch B without John's Branch A decision on the record.

**The cost sentence (no fork; a Jill-decidable copy fix).** "Your first room is free to create, but more rooms need membership administration in one of your rooms" (`index.html` line 138, and the same claim in `about.html`'s onboarding section). Before writing anything, verify the actual rule in server source (room-creation limits and the membership-administration requirement — start at `server/access-requests.mjs` and the room-create path; UT2 lane 05-10 also executed a 3-room creation cap with an unscoped 429, which may be the rule strangers actually hit). Then either (i) state the verified rule in one plain sentence with its numbers, in both places, or (ii) if the rule cannot be stated plainly from source, delete the "but more rooms…" clause and keep only "Your first room is free to create." **Do not invent a price: no dollar price for rooms exists anywhere in the evidence or source this lane read.**

**The agent sentence.** Keep "one HTTP call enrolls an agent" only in its factual form and give it its door: the hero's agent paragraph already sits next to the new `For agents → /llms.txt` link; that adjacency is the fix this pack makes. Do not add accountability/vouching claims to the landing — none are verified for the public mint path (EXP-8 F11 is a perception finding; the product truth is the owner's room-level controls, which live in the room, not on this page).

### Step 4 — The getdasha entry door

Default: **change nothing.** The 302 works and both doors serve the identical hero. The priced improvement (PERF-50 A1: point getdasha `/room` links straight at the app door, −1 round trip ≈0.3–0.9 s, 1–2 lh **plus John's DNS/host call**) is **John's gate** (host/DNS is his), and the getdasha root site is a Webflow property outside this repo — UNVERIFIED from source here. If John gives the host call, the in-repo part is only: confirm `cloudflare/edge-public.mjs` behaviour at the composed head (post-#5047, since #5047 touches that file) and re-probe both doors per §5. Until then, acceptance only requires the redirect to keep working (§5 check 7).

### Step 5 — Perf remainder, only after #5047 is deployed

In this order, each measured with the A1 method before/after:

1. **CSS:** bundle + minify the five door stylesheets into the #5047 build (extend `cloudflare/build-client.mjs` — by then landed, so editing it is no longer a fence violation) or an equivalent critical-CSS split for the door. A2's priced estimate: 161,476 → ~100–110 KB raw, 5 requests → 1 (4–6 lh). `styles.css` alone (142,815 B) exceeds the entire promised door metric; a hero-only fix that ignores CSS does not meet §3.4.
2. **Wordmark font:** subset `/og/fonts/Inter-Regular.woff2` to the wordmark glyphs, or replace the wordmark with inline SVG/text. Priced 2–4 lh, −~135 KB wire cold (A1). Also raise the font/OG/icon cache class per A4 (0.5 lh config) if the subset keeps a stable filename.
3. **Header diet:** strip the discovery `Link:` / `Report-To` / `Nel` set from static-asset responses; keep on HTML/API. Priced 2–3 lh, −~1.3 KB × every asset response (A1/A4). Server-side header change — if this step touches `server/**`, the §5 close-out expands accordingly.
4. **String catalog:** do **not** attempt a catalog split in this pack. A2/A5 name it as part of the post-bundle graph split + join diet charter (10–18 lh, separate). Record the door metric **with** the catalog counted, per the PERF-50 correction in §2.6, so the number is honest either way.

### Explicit non-goals

- No bundling work (step 0 fence); no `server/http.mjs` / `server/public-assets.mjs` / manifest edits except step 5.3's header change if taken.
- No new route. In particular **not** `/api/public/door-funnel` (row 16) — that is the deep-pass stranger-door C5 funnel-read charter's build (redesign synthesis Phase 4, C5-1…C5-5), with its own route triple; hero links in this pack carry no tracking parameters.
- No `/offers` no-JS fix, no `/join` graph diet (627 KB closure — A5's separate charter), no rooms-directory fix (`muse-room` absence is a directory/pack piece), no receipt-page, og.png, lot-view, or agent-page fixes (their own packs; #5152 and #4983/#4998 are other vehicles).
- No sponsor human surface anywhere on the landing — **fork (b)**: that surface was deliberately deleted 2026-10-19 under John's approved simplification; restoring it reverses his decision and is not instructed here.
- No money, schema, or freeze-class work; no llms.txt rewrite (EXP-8 F7/F8 compaction regressions are the agent-door pack's).

## 5. Acceptance

The coordinator/Jill accepts from this section alone. All checks executed; identifiers read at the source.

**Served-bytes checks (local server from the PR head, then repeated on production post-deploy by John's Tab, §6):**

1. `curl -s <origin>/` → extract the `<section id="static-hero">…</section>` block → assert: exactly one `<h1`, ≥4 `<a href=` with targets `/about`, the pinned footer receipt URL, `/join`, `/llms.txt` (and `/offers` only if labelled per step 1.3); 0 `<script`, 0 `<style` inside the hero; the Branch A/B receipt sentence (§4 step 3) present verbatim; "a human reviews it" and "who verified it" **absent** unless Branch A wording replaced them on the record.
2. Every hero link target, anonymous GET: 200 (the receipt link: 200 on production; on a fresh local store it may 404 — accept the production read for that one target and say so).
3. `node ~/workspace/wave-2026-10-25-deepdive/stranger-door/walkable.mjs --json` against the deployed build → step `landing-hero` not BROKEN; overall door composition reported split-by-build against the 5/2/4 baseline (any other row's movement is reported, not claimed as this PR's).
4. Meta consistency: `<meta name="description">`, `og:description`, `twitter:description`, and the JSON-LD `description` are byte-identical to each other and match the hero's receipt claim.

**Test suites by name (repo `AGENTS.md` check commands apply):**

5. `node --test tests/static-hero-nojs.test.js tests/landing-hero.test.mjs tests/landing-discovery-links.test.js tests/landing-hero-exp.test.mjs tests/front-door-routes.test.js` → all pass, with the static-hero diff showing the deliberate pin reversal (step 2), not a weakened assertion (e.g. deleting the link-count check instead of inverting it is a reject).
6. Sign-in threshold re-probe (UT2 lane 01-01's WORKS definition): `GET /api/auth/signin-options` → `google.configured: true`; `GET /api/auth/google/start` → 302 to `accounts.google.com` with `code_challenge_method=S256` and a fresh `state` on two consecutive starts. Plus a **rendered-DOM** check (the §2.7 risk): with JS on, the visible sign-in wall shows no provider whose `signin-options` entry is `configured: false` (today: no visible "Continue with GitHub").
7. Both doors post-deploy: `curl -s -o /dev/null -w '%{http_code} %{redirect_url}' https://www.getdasha.com/room` → 302 to `https://room.trydemigod.com/` (or 200 if John's step-4 call landed), and the followed page's hero block is byte-identical to the app door's.
8. Boot behaviour: `scripts/entry-simplification-browser-check.mjs` and `scripts/human-experience-browser-check.mjs` pass (hero visible pre-boot, removed after boot — the checks that already assert `#static-hero` count 0 post-hydration).
9. `npm run verify:affected` clean; `npm run lint` clean (design tokens + i18n/UI-string stages included — new hero strings go through the strings system if lint requires it, not hard-coded past it).

**Perf acceptance (only for step 5, after #5047 is deployed):**

10. Re-run the PERF-50 A1 crawl (asset graph from served HTML + import closure, raw + wire bytes, request count, fetch generations) on production and file the table against §3.4's targets and A1's baseline (21–22 req / 415,354 B raw / ≈114 KB wire). The door metric definition used must state whether the 52,816 B string catalog is counted; the §2.6 caveat is discharged by stating it, not by picking the flattering definition.

**Registration sweep (per `~/AGENTS.md` "Pre-flight registration sweep"):**

| # | Item | Applies? |
|---|---|---|
| 1 | Runtime-package closure | **Conditional:** n/a for the pure `index.html` + `styles.css` + tests diff (no new `server/**` module, no new client import). REQUIRED if the implementer adds any new client module — new module into `scripts/runtime-package.mjs` allowlist + `scripts/candidate-runtime-fixture.mjs`, closure test green. Step 5.1's build change re-checks this item at that diff. |
| 2 | Error-code catalogue, both copies | n/a — no new error code. |
| 3 | Route triple | n/a — no new route (the funnel route is an explicit non-goal). If a route appears in the diff, the pack is violated: stop and re-charter. |
| 4 | Harness copy sets | **REQUIRED-check:** the entry/browser harnesses (`scripts/entry-simplification-browser-check.mjs`, `scripts/human-experience-browser-check.mjs`) exercise the hero directly — run them (check 8); if any harness copies/transforms `index.html` or `src/styles.css`, wire the changed hero markup into its copy set and say so in the PR body. |
| 5 | Store registries | n/a — no new table. |
| 6 | Generated/mirrored artifacts | **REQUIRED:** (a) `index.html` and `src/styles.css` are packaged public assets — run the candidate-manifest / asset-packaging check (`tests/asset-packaging.test.js`, via the #5047-landed generator if it has landed; never hand-edit `scripts/CANDIDATE-MANIFEST.json`); (b) `src/styles.css` hero rules are pinned in `scripts/design-tokens-baseline.json` (`.static-hero p`, `.static-hero-noscript` entries) — regenerate/refresh the baseline through its tool if a pinned rule changes, or show the pinned rules are untouched; (c) no MCP catalog change → the catalog snapshot and count pins are n/a. |
| 7 | Diff hygiene | REQUIRED if >300 changed lines: `## Large diff justification:` section in the PR body. The hero+copy+tests core should not trip it; step 5 might — split step 5 into its own PR rather than justifying a combined diff. |
| 8 | Close-out | `npm run verify:affected` + the named suites in checks 5/8. `CI=1 npm run check` additionally REQUIRED only if the diff touches `server/**` (step 5.3's header diet) — name it in the PR body if it cannot run locally. |
| 9 | Refusal-shape step | n/a — no error code removed or refusal status remapped. |

**Landing discipline for whatever PR(s) this produces:** ordinary queue, non-money, non-shared-core — batchable under Rules v2; the `ready-to-land` label is added once before heavy CI is expected to run; evidence binds to tree SHA below the money line (Ruling 41); fix lanes never merge.

## 6. Routing

- **Implementer: Claude** — client surfaces and design tokens are his map, this diff is `index.html` + hero CSS + copy + pins, and he runs his own PR train (collision note from consult-build: stay off #5100 / #5120 / #5121, NEXT-6 remainder, and his agent-first changes while slotting this in). Handover: a room work item naming this pack's path, the step order, and the §5 checks as the expected result, posted to Claude in the room; his PR is the reply.
- **Not Claude's parts:** landing + deploying bound #5047 is the **seat's** act (Grok Bot, with John's Tab on merge-gate/post-deploy work) — this pack's step 5 cannot start until that deploy is verified, and the pack's author must not re-price #5047. **Codex** is the readiness/read-back hand if the seat needs the #5047 door-metric definition confirmed (§2.6 caveat) — via `room_request_reply` with a workItemId and the expected result (a one-line metric definition, read at #5047's head).
- **Post-deploy verification: John's Tab** — owns door-verification execution (consult-build DOOR disposition; the 11-step smoke plus the filed complement pack). §5 checks 1–3, 6, 7 are theirs to run on the production build after each landing (hero PR, and again after step 5), reporting split-by-build against `ca37fee4` → the new build.
- **Jill's fleet:** verification only — re-run `walkable.mjs`, settle/price the PR(s), and confirm the pin reversal is on the record. Never merges.
- **John's gates touched, named not decided here:** (a) the verified-delivery vocabulary fork (§4 step 3, Branch A) — the pack ships Branch B without him; (b) the getdasha host/DNS call (§4 step 4) — the pack ships without it. Neither gate blocks the core fix.

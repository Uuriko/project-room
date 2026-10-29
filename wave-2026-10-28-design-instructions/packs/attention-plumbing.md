# Instruction Pack — ATTENTION PLUMBING (needs-me / attention plumbing for agents)

Slug: `attention-plumbing` · Wave: wave-2026-10-28-design-instructions
Target tree: **main `aaa749065a6451321a949ddcb923f3174504fe35`** for all verification and for the
room_since build's drift check. Production is build `ca37fee4` and does **not** contain any of
this piece yet. Do not read the stale shared clone at `~/workspace/project-room` as main; read
source via `git archive <sha>` into scratch or `gh api` / `gh pr view` at the named head.

This pack commissions **no re-build of the already-built legs**. It instructs, in order:
(1) settle + land the two built draft PRs, (2) build `room_since` on top of them, and
(3) charter — separately, never bundled — the charter legs that were never built.

## 1. The piece

The pull surface every polling agent uses to answer "what needs me, right now, across all
my rooms", plus the cross-room delta read designed to sit on top of it.

| Surface | Where it lives (verified at main `aaa749065a`) | Verified fact |
|---|---|---|
| Core function | `collectNeedsMe(store, secret, { since, roomId })`, `server/needs-me.mjs:631`, **sync**; file is 763 lines | Standing sections beside `items`: `openWork`, `reviewAsks`, `myWork`, `myClaims`, `actionsNeeded`, `paused` (conditional). Standing sections never move the cursor. |
| Cursor parser | `parseNeedsMeSince(since)`, `server/needs-me.mjs:97` | Accepts a number / numeric string / cursor object `{rooms, land, landIds, roomAfter?, floor?}`; malformed → `422 invalid_cursor`. Pass the returned cursor back unchanged while `hasMore` is true. |
| HTTP | `GET /api/needs-me`, handler `server/http.mjs:3610`, rate `needs-me:<addr>` 60/min | Identity secret (`pri_…`) or scoped API key (`rak_…`); room tokens refused for this identity-wide read. |
| MCP | `room_needs_me`, `server/mcp-hosted-tools.mjs:24` | Same read as HTTP; "Pass roomId to scope one room; omit it for the cross-room read." |
| Escrow read the new leg consumes | `store.bountyEscrow.listBounties(roomId)` on the same `RoomStore` (`server/store.mjs:1478` at the build base; same `this.db`) | One indexed-by-room SELECT + view mapping — the falsifier check that made the pull leg buildable inside needs-me (see §2). |
| Enforcement the projection must agree with | `disputeBounty` / `decideDispute` in `server/bounty-escrow.mjs`; `resolveTier1` in `server/dispute-arbiters.mjs` | Seated decider = `bounty.disputeDecider ?? bounty.verifier`, resolved through the dispute record at enforcement time. |

**Built leg A — ATT, draft PR #5125** (verified this lane via `gh pr view 5125`):
OPEN, draft, unlabelled, branch `jill/att-needs-me-bounty-attention`, base `d5512d86`,
cured head **`97fed088cd109642ff1b9eca2416e752c973fbbf`**, exactly 2 files, +436/−3:
`server/needs-me.mjs` (+154/−3) and `tests/needs-me-bounty-attention.test.js` (+282).
It adds one standing section, `bountyAttention`, assembled per room beside `items`:

- **Decider leg:** while a bounty is `disputed` and this member is the seated decider
  (`disputeDecider ?? verifier`), exactly one row
  `{ role:"decider", why:"dispute_awaiting_ruling", bountyId, disputeId, poster, claimant, amount, disputeAgeMinutes, next }`,
  `next` pointing at the dispute-decide route.
- **Poster leg:** one row per own bounty in `claimed` (awareness) / `submitted`
  (action: review) / `disputed` (own side, grounds-free) / terminal `paid`/`refunded`/`cancelled`
  (outcome record).
- **Worker leg:** the same state set from the claimant side, including money + claim bond at stake.
- One row per (bounty, role) — a member holding two roles on one bounty gets both rows.
  Rows are built by explicit field pick, never by spreading the bounty view: **no
  evidence, criteria, grounds, rubric, attestation, resolution or submission hash ever
  appears in a row.** Terminal outcome rows retire at exactly
  `BOUNTY_OUTCOME_WINDOW_MS` = 7 days (shown at 7 d, gone at 7 d + 1 ms); live rows have no window.
  Per-room cap `BOUNTY_SHOWN = 10` on `top`, `count` reports the full total (see §2, accepted minor).

**Built leg B — NM, draft PR #5137** (the memoisation ATT's consumer depends on):
OPEN, draft, unlabelled, cured head **`e3aae85bbde3c67a91baa610586498a58ed2e3ab`**, 3 files
(`server/needs-me.mjs`, `server/work-claim-sqlite.mjs`, `tests/needs-me-memo.test.js`).
It memoises `collectNeedsMe` per store on a **room-set version key** — identity + room-scope
signature + seat signature + per-room sequence/archived + exact work-claim board version +
land/bonds/wake-pause aggregates (the cured key also folds in the `wake_queue_pause_by`
probe, `pauseSig`) + a **computed validity horizon** (earliest time-derived flip; no
arbitrary TTL). Output on a hit is byte-identical; errors are never cached; the memoised
value is cloned on store and on serve. Stated limitation, in code and PR body: the board
counter is process-local, so the memo is correct under the production single-writer /
single-store assumption only.

**Designed leg C — RS, `room_since`** (design FILED, **no code, no PR**):
`~/workspace/wave-2026-10-27-consult-build/lanes/RS/DESIGN.md` (~25 KB, base `d5512d86`).
A cross-room, identity-scoped, **pure-delta** read: `collectRoomSince(store, secret, { cursor, roomId })`
in a **new** `server/room-since.mjs`; `GET /api/room-since` beside the needs-me handler;
MCP `room_since` (full profile at build; core-profile inclusion is the lean-catalog owners'
call, not this build). One cursor object, three independent watermark families: the
needs-me sub-cursor embedded **verbatim**, plus per-room `decisions` and `claims` journal
watermarks. Buckets: `asks`, `messages`, `claims`, `decisions`, `landChanges`, plus exact
per-room `coverage`. No standing sections (they would break the no-duplicates guarantee) —
in particular `bountyAttention` is a deliberate v1 exclusion from room_since.
**Hard sequencing (DESIGN §3): the RS build starts only after #5125 AND #5137 have MERGED,
API-verified. This is not a preference; building against the pre-ATT/NM seam prices the wrong interface.**

**Bindings check (this lane, 2026-10-28):** neither #5125 nor #5137 is a key in `prs`
(259 entries) nor present in `watched` (130 entries) in
`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`.
Both are **unbound** and queue for **settle pass 22** — consult-build SYNTHESIS §6 intake
lists #5125 @ `97fed088` and #5137 @ `e3aae85b` in exactly that state. Nobody may cite
either PR as bound, priced, or landed until a settle pass binds it at a verified head.

Neighbour on the same file: **#5136 (RC, request-changes)**, draft @ `91661d94`, also touches
`server/needs-me.mjs` (+45/−2, its needs-me entry carries the review summary **unclipped** —
a deliberate difference from the work-claim entry's clip; do not "harmonise" it). Whichever
of #5125 / #5136 / #5137 lands second or third rebases; the composed head, not any single
PR head, is the evidence surface.

## 2. Current state

All items below are executed evidence on file; nothing is re-derived here.

1. **At main `aaa749065a`, the blindness is still total (verified this lane).**
   `git archive aaa749065a` of `server/needs-me.mjs`: `grep bountyAttention` = **zero hits**;
   `collectNeedsMe` returns no bounty section of any kind. Production `ca37fee4` is older still.
2. **The failing baseline (UT2, EXECUTED).** Charter
   `~/workspace/wave-2026-10-27-ut2-conversion/charters/attention-plumbing.md` §1:
   `GET /api/needs-me` returned `items: []` for poster, worker **and decider** during both
   adjudicating windows (decider had a live ruling to make; worker had 4 credits + a bond at
   stake) and after both rulings — "Nobody is told a ruling happened." Bounty events generally
   (02-04 F5): `items: []` after accept, after reject, after request-changes attempts, while a
   work-claim `changes_requested` in the same room **did** reach the worker's needs-me. "The
   attention machinery exists and fires for work, not money."
3. **The charter falsifier did NOT fire (ATT lane, executed).** The pull leg was killable if
   needs-me could not read the escrow store without breaking its latency shape. It can:
   `store.bountyEscrow` sits on the same store/db, `listBounties` is one indexed SELECT —
   the same cost class as the `claimBoardOf` read needs-me already does per room.
   (ATT REPORT, `~/workspace/wave-2026-10-27-consult-build/lanes/ATT/REPORT.md`, "Falsifier".)
4. **#5125 was critic-FAILED, then cured on the same branch — do not re-open the cured defect.**
   ATT-CRITIC D1 (MEDIUM): the decider never recorded the outcome — charter §6 requires
   "after ruling, **all three parties'** needs-me records the outcome once", but the filed head
   `794ddb46` gave outcome rows only to poster/worker and the decider's row vanished on
   `approved`/`paid`/`refunded`. ATT-CURE fixed it in-shape (seat hoisted out of the `disputed`
   branch; `ruledDispute = isDecider && disputeId` non-empty; decider outcome row in the same
   7-day window, including a windowed outcome row on `approved`; no row for an undisputed
   outcome or a non-designated verifier). Failing-first both directions: uncured head + new
   tests = 7 pass / 3 fail; cured head = **10/10** in `needs-me-bounty-attention.test.js`,
   neighbouring needs-me suites **73/73**. Coordinator re-verified the cured suite 10/10 in a
   pristine extract (consult-build SYNTHESIS §3, ATT line).
   (Sources: `lanes/ATT-CRITIC/REPORT.md` §4–§6; `lanes/ATT-CURE/REPORT.md`.)
5. **#5137 was likewise critic-FAILED, then cured.** NM-CRITIC D1: a governor hardening a
   self-pause upserts only `wake_queue_pause_by`, invisible to the memo's pause probe — a
   demonstrated stale read. Cure folds the pause-by probe into `pauseSig` + a characterisation
   test, failing-first both directions. Defect 2 (process-local board counter) was **executed**
   by the cure lane with a two-handle probe and dispositioned, not redesigned: limitation
   demonstrated, single-writer assumption stated in code + PR body. Cured-head close-out:
   memo suite 5/5, needs-me family + neighbours **142/142**, `npm run verify:affected` exit 0.
   (Source: `lanes/NM-CURE/REPORT.md`; consult-build SYNTHESIS §3, NM line.)
6. **Why the memo matters, in numbers.** PERF-50: `room_needs_me` is "the most prescribed
   read, the most expensive call (~80 ms p50)" (`wave-2026-10-27-perf-50/SYNTHESIS.md`, E2).
   NM's bench at `d5512d86` (in-memory, 10 rooms / ~400 claims): full call 107.8 ms,
   caught-up repeat 55.3 ms, ~52 ms of it claim-board list + decode recomputed per poll.
   Consult-build SYNTHESIS §3 records the shipped result: **repeats 107.8 → 0.9 ms**.
7. **Accepted minors on #5125 — named, not defects to silently fix.** (a) `top`-10 cap can
   hide an 11th dispute row while `count` says 11; every standing section shares this pattern
   and no shape-consistent small change exists (consult-build SYNTHESIS §5.7; ATT-CURE,
   "Secondary"). (b) Seat-projection residual: the projection reads the bounty designation,
   enforcement reads the dispute record (incl. `raisedBy` and active-membership guards); the
   critic traced that **no code path today creates a divergent record** — the exposed
   population is at most pre-#3727 legacy disputes, which timeout-settle after 14 days
   (ATT-CRITIC §1). Both ride with the PR; fixing either is a new charter, not a landing fix.
8. **Charter legs that were NEVER built (no PR exists for any of them in the consult-build
   record — checked in the SYNTHESIS intake, §6):**
   - (iii) **poster / public-offer claim leg** — a claim on your public offer visible in
     needs-me with holder + lease expiry (charter §5(iii); baseline 02-03 F-4/F-5).
   - (v) **watcher leg** — transitions on bounties you watch via `bounty_watch` (charter §5(v)).
   - **Push leg delivery** — wake signals for dispute-opened → seated decider,
     dispute-ruled → poster + worker, bounty-settled (paid/refunded) → poster + worker.
     ATT shipped the **copy contract only**: at `d5512d86` no surface promises a bounty wake
     and `WAKE_KINDS` (`mention, dm, bond, assignment, land, ask`) has no bounty kind, so
     promise and queue agree (both absent) and **no copy correction is owed**. Delivery is
     inside the T4 wake-rebuild budget, not additive; building a parallel wake path is
     explicitly out of scope (charter §2 fence).
   - **§4 `decide` sub-question** — permission-vs-kind-rule adjudication for `decision.recorded`.
     Needs its own ruling (Jill, under standing delegation; no money/schema semantics);
     it is neither charter's build and must not be smuggled into any leg here.
   - The T-30m work-claim holder warning belongs to the **wave-1** claim-expiry-warning
     charter, not this piece. Do not re-charter it here.
9. **UNVERIFIED:** live production behaviour of `bountyAttention` / the memo — neither PR has
   landed, so no production probe can show them. Any report claiming otherwise is wrong.

## 3. What fantastic means

An agent that was asleep wakes, makes **one** poll, and sees every money obligation that
touches it — with no grounds, no prose, and nothing it must act on missing.

- **During a dispute:** the seated decider's `GET /api/needs-me` carries **exactly one**
  `dispute_awaiting_ruling` row naming the dispute, its age in minutes, and the ruling
  action; poster and worker each carry their own `dispute_open` side. Zero rows for any
  other member, including a verifier who is not the designated decider.
- **After the ruling:** all three parties record the outcome **once** — poster and worker
  get their `bounty_<terminal>` row, the decider gets the same-shaped decider outcome row —
  and every outcome row is gone at 7 days + 1 ms. A bounty poster/worker pair see **each**
  lifecycle transition as a row **within one poll** of the transition.
- **No leakage, ever:** an adversarial bounty poisoned with marker strings in
  evidence/criteria/grounds/resolution/attestation/rubric/submissionHash renders rows for
  all reachable states × all three roles with **zero** markers present (the critic's probe;
  this stays the acceptance shape).
- **Cursor honesty:** escrow-only transitions between polls (claim → submit → dispute,
  no room events) change the standing section while the returned cursor stays
  **byte-identical** and `items` stays identical — standing state never moves the cursor.
- **Cost:** a caught-up repeat poll at the NM bench shape (10 rooms, ~400 claims) is
  served from the memo at **~0.9 ms** against 107.8 ms uncached, byte-identical output,
  and no input change — room event, registry write, land change, bond change, pause
  change (including a governor pause-hardening), or a modelled time flip — is ever
  served stale.
- **After RS lands:** one `room_since` call replaces "list rooms + digest each + re-read
  needs-me + diff boards myself". A full walk from one starting cursor delivers each
  eligible row **exactly once**; re-polling with the returned cursor after no new events
  returns empty buckets and a **byte-identical cursor**; nothing is ever shed — caps
  (25/room, 100/bucket, oldest-first) paginate with `hasMore`, worst case ~300 bucket
  rows + 100 needs-me items (~120 KB). Match exemplar: the digest's coverage honesty
  (delivered + pending = total, provable from `coverage`) without digest's byte-shedding.

## 4. The instruction

Work in this order. Steps 1–2 land what exists; step 3 is gated on them; step 4 is
separate charters. **Never duplicate a bound or built leg.**

### Step 0 — Preconditions (read-only, ~15 min)
1. Re-read both PRs at the API: `gh pr view 5125` and `gh pr view 5137`. Proceed only if
   state = OPEN, draft = true, and heads are exactly `97fed088` (#5125) and `e3aae85b`
   (#5137). Any head move voids the consult-build acceptance records — stop, name the new
   head, and return to the coordinator for re-pricing. Do not re-cure, rebase "helpfully",
   or amend either PR body.
2. Confirm the bindings state yourself in
   `landing-watch-bindings.json`: both PRs unbound at pack time. If a settle pass has
   since bound one, follow that record instead of step 1 for that PR.

### Step 1 — Settle pass 22 prices and binds #5125 + #5137 (Jill's fleet; never merges)
1. Price both PRs from the consult-build §6 intake records (cured heads, critic records,
   named CI-owed suites travel with each PR body — read them; do not re-derive them).
2. Add the `ready-to-land` label **once** per PR, with a user token or App installation
   token (never `GITHUB_TOKEN`) — heavy CI runs only on labelled PRs; an unlabelled
   "instantly skipped" generation is by design, not a failure, and re-runs do not cure it.
3. Merge-up: both PRs, and neighbour #5136, touch `server/needs-me.mjs`. Compose them in
   seat order at the composed head and verify the composed tree still contains **all**
   of: `bountyAttentionOf` + the decider outcome row (#5125), the memo key incl. the
   `pauseSig` pause-by fold (#5137), and — if #5136 is in the same batch — the unclipped
   request-changes summary entry (#5136). Below the money line, Ruling 41 tree-SHA
   evidence discipline applies; neither PR changes money semantics (no journal movement,
   no balance/bond/strike writes — #5125 is a read projection, #5137 a read memo), so
   neither is a freeze-class single on that ground. The landing seat makes the final
   batching call; this pack does not override seat order.

### Step 2 — Land, deploy, verify (landing seat; see §6)
1. Land at the composed head, green, verified at the API (merged state + merged head read
   back, not inferred from CI).
2. After deploy, run the post-deploy probe in §5.4 on the new production build. Until that
   probe passes, every claim about this piece in production is UNVERIFIED.

### Step 3 — Build room_since (ONLY after step 2 is API-verified for BOTH PRs)
Full spec: `lanes/RS/DESIGN.md` — implement §1 exactly, compose per §2, in this sequence:
1. **Step 0a — Falsifier (blocking, DESIGN §5).** On the DESIGN T2 fixture, script the
   composition of ≤2 existing calls (`room_needs_me` + per-room `/digest`). If it yields
   field-equal output for all four buckets, **do not build** — file the composition as a
   client helper and stop. (At design time it fails on evidence: digest caps decisions
   at 2 and messages at 3 per room, sheds under a 4,096-byte budget, and is per-room;
   needs-me has no decisions bucket and no claim-change delta.)
2. **Step 0b — Drift check D1–D7 (blocking, ~0.5 lh, DESIGN §3).** Diff the exports and
   return shapes of `server/needs-me.mjs` at the post-merge main tip against the pinned
   table: D1 `collectNeedsMe` signature/sync-ness/top-level keys/item kinds (expect the
   additive `bountyAttention` key — tolerated, room_since ignores unknown top-level keys;
   expect possible NM-added options/cache keys), D2 `parseNeedsMeSince`, D3 returned
   cursor shape, D4 `myClaimsOf`/`actionsNeededOf` field semantics, D5
   `store.workClaims.list` + `releaseExpired`, D6 `identityRoomSeats` / `roomAuthority`,
   D7 journal row shapes. Any mismatch beyond additive keys ⇒ STOP, record the delta in
   the PR body, re-price, get the coordinator's go. Never improvise around a moved seam.
   **Deadline rule:** if #5125 or #5137 has not landed within 14 days of the RS design
   (filed 2026-10-27), the coordinator re-decides sequencing explicitly — silence is not a landing.
3. **Build (one PR, draft, unlabelled until author + critic pass completes).** New file
   `server/room-since.mjs` only for core logic; one handler block in `server/http.mjs`
   (rate `room-since:<addr>` 60/min, same credential funnel, `401 room_token_not_identity`
   for room tokens); one MCP tool row in `server/mcp-hosted-tools.mjs` + blurb in
   `CORE_MCP_BLURBS` (`src/room-mcp-join.js`), **full profile only**; OpenAPI fragment +
   `docs/openapi.yaml` operation. Call `collectNeedsMe` **first** for auth and for the
   asks/messages/landChanges buckets (split its items by kind, re-sort `(roomId asc, seq asc)`);
   embed its returned cursor verbatim. Decisions/claims are journal enumerations per room
   (patterns from `store.roomDigest`, never a call to it — it is per-room, capped, and shedding).
   Clamp ahead-watermarks, never 409; name `clampedRooms` / `floorApplied` / `droppedRooms`.
   **Touch zero lines of `server/needs-me.mjs`, `server/room-digest.mjs`, or `/digest`
   behaviour.** If an export you need does not exist, stop and re-price (DESIGN §2 additivity guarantee).
4. **Critic pass (mandatory author+critic pair).** The critic re-runs T1–T9 from the
   DESIGN spec, not from the author's summary.
5. Price guardrail: **7 lh point / 10 lh ceiling** (DESIGN §5 breakdown). At 50% with
   T1–T9 not yet green, report; at ceiling, stop as BLOCKED-budget.

### Step 4 — The unbuilt legs are separate charters, never bundled into step 3
Charter each on its own, in this order, only when the coordinator slots them:
(a) poster public-offer claim leg (charter §5(iii)) — a new standing section or a
`bountyAttention` sibling; re-run the §7 falsifier shape before assuming the seam;
(b) watcher leg (charter §5(v)) — first verify what `bounty_watch` records today at the
build's base; (c) push-leg delivery — **only** inside the T4 wake rebuild, datums fixed
by ATT's copy contract (dispute-opened / dispute-ruled / bounty-settled, §2.8); no parallel
wake path, no new `WAKE_KINDS` entry outside T4; (d) the §4 `decide` question — Jill's
ruling first, fix second, never the reverse.

### Explicit non-goals
- No re-build, re-cure, or "improvement" of #5125 / #5137; no fix for the two accepted
  minors (§2.7) inside any landing or the RS build.
- No standing sections inside room_since v1 (incl. `bountyAttention`); no message/decision
  bodies (clips + ids + existing follow-up reads only); no byte budget / shedding in room_since.
- No new wake path, no copy promising a bounty wake, no T-30m holder warning (wave-1 charter).
- No inbox/notification family work; no `decide` fix without the §4 ruling.
- No merges, labels, or bindings edits by any fix/verification lane; no production writes.

## 5. Acceptance

The coordinator accepts each step from these checks alone. All test evidence is
in-memory store mode unless a check says otherwise (the suites' own mode).

### 5.1 For #5125 at its bound head (re-run, do not trust the lane reports)
```
node --test tests/needs-me-bounty-attention.test.js   # expect 10/10
node --test tests/needs-me.test.js tests/needs-me-my-claims.test.js \
  tests/needs-me-open-work.test.js tests/needs-me-snippet.test.js \
  tests/needs-me-mention-edits.test.js tests/board-needs-me.test.js \
  tests/needs-attention-board-review.test.js tests/needs-attention-retry.test.js
                                                      # expect the 73/73 neighbour batch green
node ~/workspace/fleet-tools/registration-sweep.mjs --pr 5125   # expect no MISSING
```
Plus the critic's three probes, re-run against the bound head: (i) lifecycle integration
through a real `RoomStore` — post → fund → claim → submit → accept → dispute → decide;
during the dispute the decider has exactly one `dispute_awaiting_ruling` row with the
dispute age (pin: 90 min after clock advance), poster/worker carry `dispute_open`; after
the ruling the decider section is exactly one `["decider","bounty_<terminal>"]` row and
poster+worker exactly one outcome row each; (ii) poisoned-bounty leak scan across all
reachable states × 3 roles = zero markers; (iii) cursor byte-identical across escrow-only
transitions at a fixed `since`. `gh pr view 5125`: head, draft/label state, and 2 changed
files match the settle record before landing.

### 5.2 For #5137 at its bound head
```
node --test tests/needs-me-memo.test.js               # expect 5/5, incl. the governor
                                                      # pause-hardening characterisation test
# family + neighbours batch from lanes/NM-CURE/REPORT.md  # expect 142/142
npm run verify:affected                               # expect exit 0
node ~/workspace/fleet-tools/registration-sweep.mjs --pr 5137   # expect no MISSING
```
Plus: grep the head for the single-writer assumption comment in
`server/work-claim-sqlite.mjs` and confirm the same statement is in the PR body; confirm
a memoised repeat is JSON-byte-identical to the fresh computation on the characterisation
stream (the suite pins this — a green suite with the pin removed is not acceptance).

### 5.3 For the room_since build PR
```
node --test tests/room-since.test.js                  # T1–T9 from RS DESIGN §5, all green:
  # T1 bootstrap/genesis · T2 mid-stream 4-row poll · T3 idempotent re-poll (byte-identical
  # cursor) · T4 continuation 25+5, hasMore flips · T5 clamped cursor, no 409 ·
  # T6 handled-ask honesty · T7 additive regression · T8 auth/scope · T9 malformed cursors → 422
node --test tests/needs-me.test.js tests/needs-me-bounty-attention.test.js \
  tests/needs-me-memo.test.js tests/room-digest.test.js tests/board-needs-me.test.js
                                                      # T7: unchanged and green
npm run verify:affected                               # exit 0
CI=1 npm run check                                    # required: diff touches server/**
node ~/workspace/fleet-tools/registration-sweep.mjs --pr <n>   # no MISSING (see 5.5)
```
Plus: the drift-check record (D1–D7, pass or the recorded delta + coordinator go) is in
the PR body; the falsifier result from step 0a is in the PR body; `git diff` against the
base shows **zero** changed lines in `server/needs-me.mjs`, `server/room-digest.mjs`.

### 5.4 Post-deploy probe (after either landing batch deploys)
Read-only, on both production doors (`https://room.trydemigod.com`,
`https://www.getdasha.com/room`): `GET /api/version` names the new build; then, with a
test identity seated in a room carrying a live disputed bounty, `GET /api/needs-me` for
the decider identity returns the `bountyAttention` section with exactly one decider row,
and a second immediate poll returns byte-identical standing sections (memo live). No
writes to production beyond the test-bounty lifecycle the probe itself is chartered for;
if no such fixture may be created, record the probe as NOT RUN — never as passed.

### 5.5 Registration sweep — what each change trips
| Sweep item | #5125 / #5137 (already swept at their heads: **no MISSING**) | room_since build |
|---|---|---|
| 1. Runtime-package closure | n/a — no new module; needs-me already allowlisted | **REQUIRED** — `server/room-since.mjs` + full import closure into `scripts/runtime-package.mjs` allowlist AND `scripts/candidate-runtime-fixture.mjs` |
| 2. Error-code catalogue, both copies | n/a — no new error code | n/a if §1.6 holds (existing codes only); **REQUIRED both copies + `skills-sync.mjs`** if the build adds any code |
| 3. Route triple | n/a — no new route (existing `GET /api/needs-me` gains a section / a memo) | **REQUIRED** — `server/routes/table.mjs` row with `parity: "mcp:room_since"`, legacy allowlist if on the legacy chain, `docs/openapi.yaml` operation + bare-path quickstart example, well-formed `x-room-permission` on the operation |
| 4. Harness copy sets | n/a — no harness-copied module changed shape | **REQUIRED if** any harness copies `room-since.mjs` or its imports — check each harness copy/re-point set |
| 5. Store registries | n/a — no new table | n/a — no new table (journal + existing stores only) |
| 6. Generated / mirrored artifacts | n/a — no EVENT_TYPES / MCP catalog change | **REQUIRED** — MCP catalog growth moves the count pins in `tests/mcp-search-actions.test.js` + `tests/mcp-untrusted-content.test.js` (run both by name; `verify:affected` does not select them); regenerate the candidate manifest / catalog snapshot the diff touches |
| 7. Diff hygiene | SATISFIED on both (439 lines on #5125, justification in body) | **REQUIRED** — expect >300 lines; `## Large diff justification:` in the PR body at filing |
| 8. Close-out | REQUIRED — named suites in 5.1/5.2; `verify:affected` named in the bodies where not run locally | REQUIRED — §5.3 incl. `CI=1 npm run check` (touches `server/**`) |
| 9. Refusal-shape step | n/a — no error code removed / status remapped | n/a — same reason, unless step 2's condition fires |

## 6. Routing

- **Settle + verification (steps 0–1, all acceptance re-runs): Jill's fleet.** Verification,
  cures and settle passes are fleet work; the fleet never merges. Handover: the settle
  pass 22 record (bound head + priced record per PR) posted where the seat reads it.
- **Landing (step 2): Grok Bot, the landing seat**, in stack/slot order with John's Tab,
  from the composed head verified in step 1. #5125 and #5137 carry no money semantics and
  no schema change, so no freeze ceremony; if the seat composes them with a money or
  shared-core PR, that PR's rules govern the batch.
- **room_since build (step 3): Codex** — this is server/core work (new server module,
  journal queries, MCP + route registration), and all Codex utilisation happens inside
  Project Room. Handover channel: `room_request_reply` to Codex's exact member with a
  concrete ask, a `workItemId`, and the expected result (this pack + RS DESIGN.md as the
  spec; expected result = one draft PR at the §5.3 acceptance bar). **Author+critic is
  mandatory:** a Jill-fleet critic lane re-runs T1–T9 from the DESIGN spec before the PR
  is labelled or priced. Claude is not the implementer here (no client surface in this
  piece); Fo is not chartered (no browser-shard evidence is load-bearing — all suites are
  in-memory store tests).
- **Post-deploy verification (step 5.4): John's Tab** (post-deploy verification is its
  standing duty), with the fleet probe above as the script; results read back by Jill's
  fleet before the piece is reported live to John.
- **Step 4 charters:** return to Jill (coordinator) for slotting; the `decide` ruling in
  §4(d) is Jill's under John's standing delegation, recorded before any fix is chartered.

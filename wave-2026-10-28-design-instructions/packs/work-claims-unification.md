# Instruction pack — Work-claims unification (work items vs Board `work_claims`)

## 1. The piece

**What it is.** The unification of Project Room's two records of the same work
into one: the projection **work items** (`state.workItems`, written by the
`src/events.js` reducer from the browser work-item form and the MCP work
tools) and the Board **work claims** (SQLite `work_claims`, validated by
`workOf` in `server/work-claims.mjs`, persisted via
`server/work-claim-sqlite.mjs`). The end state, per Claude's proposal, is:
`work_claims` is the sole work record, there is one create door, and one
"needs you" list feeds Overview / Catch up / Decisions / What needs me.

**PAUSED — executable at unpause.** This piece belongs to the redesign
typed-object phase (Claim / Record / Verdict / Lease / Ruling as the one
typed event family; `~/workspace/pr-redesign-2026-10-23/SYNTHESIS.md` §"The
end-state is E3/E11's"). That phase is **PAUSED per FOCUS-REVIEW**, and
Jill's hold on this exact shape change is on record (Jill seq 20696;
Claude acked seq 20738;
`~/workspace/pr-redesign-2026-10-23/DESIGN-INPUT-claude-work-claims-2026-10-27.md`,
"Status" and "Jill's disposition"). **Do not start any step in §4 until
Jill re-charters the typed-object phase and lifts that hold in writing.**
This pack is written so the implementer can start within one hour of that
unpause, not before it.

**Target tree.** Instructions target **main
`aaa749065a6451321a949ddcb923f3174504fe35`** (short `aaa749065a`), verified
by `git archive` of that SHA into this lane's scratch (see below). They do
NOT target live production `ca37fee4`. Re-verify the base at unpause: if
main has moved, re-run the §4 Step 0 census before writing code.

**Where it lives (verified at `aaa749065a` via `git archive`).**

- `server/work-item-board.mjs` (1,155 lines) — the duplication machinery
  itself. Header (lines 3–24): "Every projection work item … gets a
  first-class row on the work-claims board (SQLite `work_claims`, keyed by
  `boardClaimId(workItemId)`). The mapping in this module is the single
  definition of 'what the board should say about a work item'." Exports
  read in full or in part: `boardClaimId(workItemId)` (line 89; board-safe
  ids pass through, others are reversibly encoded with an `_e` prefix or
  `_h`+SHA-256 fallback), `boardClaimForWorkItem` (line 430),
  `planWorkItemBoardBackfill` (line 748), `backfillRoomWorkItems` (914),
  `diffRoomWorkItems` (964), `backfillAllRoomsWorkItemBoard` (984),
  `WORK_ITEM_BOARD_SYNC_TYPES` (1034: 12 event types — `work.accepted`,
  `work.started`, `work.blocked`, `work.blocker_resolved`,
  `work.completed`, `work.superseded`, `work.handoff_recorded`,
  `claim.acquired`, `claim.renewed`, `claim.released`,
  `verification.recorded`, `owner.decision_recorded`),
  `syncWorkItemClaim(store, roomId, actorId, incoming, state)` (1063 — the
  one-way write path, invoked from the command layer), and
  `DIVERGENCE_REPAIR_NOTE` (41) with the persisted
  `work_item_board_divergence` table and `workItemBoardDivergence()` (893).
- `server/work-claims.mjs` (1,817 lines) — the Board claim state machine
  (`workOf`, claim/lease/review logic, `roomWorkClaimConfig`,
  `openClaimCount`); header: claims start unclaimed → claimed →
  in_progress → done/blocked, only the claiming agent may update, default
  lease 24 h, cap 168 h.
- `server/work-claim-sqlite.mjs` — the durable registry: whole claim rows
  stored as JSON, every read re-validated through `workOf`;
  `WORK_CLAIM_FIELDS` / `WORK_CLAIM_DEFAULTS` enumerate the canonical
  claim field set (id, title, state, owner, history, leases, delivery,
  verification, chain, `workItemId`, `claimRound`, …). This field list is
  the starting census for §4 Step 1.
- `server/work-claim-routes.mjs` (1,669 lines) and
  `server/routes/work-claims.mjs` (`WORK_CLAIM_ROUTES`: provenance,
  close, cancel, `work-claims-read`, retention) — the Board-native door:
  REST + hosted MCP create/claim/update/release/review/close/cancel on
  `/api/rooms/{roomId}/work-claims…` (OpenAPI fragments 0113–0128, 0141 in
  `server/openapi/fragments/`).
- The second create door (verified from the `work-item-board.mjs` header,
  lines 5–8): projection work items are created through the event reducer
  (`work.proposed` in `src/events.js`) by "the browser work-item form and
  the MCP work tools", then synced item→board. The reducer file itself
  was only spot-read in this lane (`WORK_PROPOSED: "work.proposed"`);
  treat exact reducer internals as to-be-confirmed in §4 Step 0.
- Receipts, both prefixes (verified in
  `server/public-read-model.mjs` at `aaa749065a`): public receipt ids match
  `/^(?:pwr_…|wcr_[a-f0-9]{32}|wir_[a-f0-9]{32}|lot_…)$/` (line 30);
  `wcr_` = `hashId("wcr", roomId, claim.id)` for Board claims, `wir_` =
  the receipt a completed board work item projects for itself, with an
  explicit de-duplication branch (lines ~320–340): "A completed board
  work item projects its own wir_ receipt in the loop below; the claim
  the board sync mirrors it into (same id) must not project the same
  completion a second time as a wcr_ row." Member receipts add a third
  surface in `server/work-claim-routes.mjs`: `receiptId: "rc_" + item.id`
  (line 468), whose public twin is resolved by trying **both**
  `publicWorkClaimReceiptId(roomId, item.id)` and
  `publicWorkItemReceiptId(roomId, item.id)` (line 508, comment lines
  495–505).
- The "needs you" reader (verified): `server/needs-me.mjs` — cross-room
  "what needs me" composing mentions, reply asks, handoffs, DMs, bond
  requests, land-queue rows, **plus** standing Board sections (`openWork`
  from `server/available-work.mjs`'s `availableBoardRows`, `reviewAsks`,
  `myWork`, `myClaims`, `actionsNeeded`) — i.e. today it must already
  merge both stores' shapes to answer one question. Adjacent surfaces it
  feeds (Overview / Catch up / Decisions / What needs me) are named in
  Claude's proposal; their client files were **not read in this lane —
  UNVERIFIED**; the client implementer confirms them in §4 Step 0.
- Adjacent unlinked work records (Claude's second-order finding):
  `server/request-runs.mjs` — SQLite `request_runs` table for reply
  requests (verified: its own table, own lifecycle states; the
  `workItemId` link Claude described as optional was **not found by grep
  in this file at `aaa749065a` — UNVERIFIED, re-check in Step 0**), and
  the bounty family (`server/bounty-*.mjs`, OpenAPI fragments 0150–0168)
  with its own claimant/criteria and no claim link.
- Shape census pin: `tests/workitems-migration-census.test.js` (named in
  the `work-item-board.mjs` header as PR #3282's pin of work item / claim
  / receipt / verification / decision key sets). Test-tree neighbours
  verified by archive listing: `tests/board-native-record.test.js`,
  `tests/board-needs-me.test.js`, `tests/board-projection.test.js`,
  `tests/available-work.test.js`, `tests/agent-work-claimable.test.js`.

**Already bound — do not duplicate (bindings file
`~/workspace/goals/uuriko-project-room-bug-fix-program/hidden_files/landing-watch-bindings.json`,
read this lane).** These harden the *current* dual-store design and must
land (or be explicitly dispositioned) before unification starts; §4
instructs only what remains after them:

- PR **#3556** @ `659f196c` — fence core work claims: claimGeneration
  round token + state-machine lease enforcement (issue #3545 cure).
- PR **#3629** @ `be600c55` — issue #3221 B-4 slice 2: decision-gate
  board fields, `server/work-item-board.mjs` backfill version 2; stack
  base for #3641 / #3652 / #3714.
- PR **#4002** @ `7774275b` — lease never lapses while a review is
  outstanding (issue #3753 cure).
- PR **#5038** @ `f053d3ba` — S-03 work-claim transaction runner.

## 2. Current state

All findings below are Claude's design input
(`~/workspace/pr-redesign-2026-10-23/DESIGN-INPUT-claude-work-claims-2026-10-27.md`,
"The finding"), cross-checked against source at `aaa749065a` by this lane
as noted. Claude read main `d5512d86`; the mechanisms he named are all
still present, unchanged in shape, at `aaa749065a`.

1. **Same work stored twice, one-way sync, no write-back — VERIFIED.**
   `syncWorkItemClaim` reacts to the 12 `WORK_ITEM_BOARD_SYNC_TYPES`
   events and rewrites the Board row from the projection item; there is
   no Board→item path. When the Board holds live state the item cannot
   explain, the sync *skips* the row ("A board_native diverged primary
   row is the board's own live state, not the item's to rewrite: leave
   the whole sync alone"), records the divergence in
   `work_item_board_divergence`, and repair is a one-directional reopen:
   `DIVERGENCE_REPAIR_NOTE = "divergence repair: board reopened to match
   the work item; was done"`. The module header states "Zero is the only
   healthy value; any non-zero reading re-opens #3607." Divergence-repair
   history stamps are even exempt from the 200-entry history cap because
   dropping one "would destroy the only record of a repair".
2. **Two create doors, double checking — VERIFIED (mechanism).** Work is
   created as a projection item (browser form / MCP work tools →
   `work.proposed` → reducer) *or* directly as a Board claim (REST/MCP
   work-claim routes). Assignment/overlap is then enforced in both
   places: the claim state machine's owner rules in
   `server/work-claims.mjs`, and again inside `syncWorkItemClaim` (holder
   refusal 409 `work_claim_conflict`, occupied-successor refusal, plus
   the caps refusals 409 `work_board_full` / `too_many_open_claims`
   re-checked at sync time).
3. **Two public receipt prefixes for one completion — VERIFIED.**
   `wcr_` (claim) and `wir_` (work item) in
   `server/public-read-model.mjs`, with a hand-maintained de-duplication
   branch and a member-receipt twin lookup that tries both ids
   (`server/work-claim-routes.mjs` line 508). One completion, two
   possible public ids, and correctness depends on the skip logic in
   both places staying in agreement.
4. **Readers must combine both stores — VERIFIED.** `needs-me` composes
   Board sections from the claim registry while its item stream is
   event/projection-derived; `public-read-model` loops claims *and*
   `state.workItems` to build one receipts list; `work-claim-routes`
   receipts read the projection and resolve twins against the Board.
5. **Board v2 tables retired/dead — UNVERIFIED.** Asserted in Claude's
   input ("Board v2 tables retired/dead"); this lane did not enumerate
   the schema at `aaa749065a` to confirm which tables those are. Step 0
   of §4 names the check; do not delete any table on this assertion
   alone.
6. **Adjacent records unlinked — PARTIALLY VERIFIED.** `request_runs`
   exists as its own table/store (verified); bounties carry their own
   claimant/criteria routes (verified by OpenAPI fragments 0150–0168).
   The exact current link fields (Claude: reply requests have "optional
   `workItemId` only", bounties "no link") are UNVERIFIED at
   `aaa749065a` — re-census in Step 0.

No executed failure probe is claimed for this piece: the cost is
structural (a standing divergence monitor, a repair-reopen path, and
repeated fleet repair work — the design input records "the board sync
has produced repair work repeatedly" as Jill's disposition note). Any
implementer wanting a live divergence count reads
`workItemBoardDivergence(store)` / the `work_item_board_divergence`
table at unpause; this lane ran no production probe (read-only rule, and
the piece is paused).

## 3. What fantastic means

One piece of work, created once, claimed once, finished once, receipted
once — and every surface that answers "what needs me" reads that one
record.

- **One record.** After cutover, creating work through any door produces
  exactly one `work_claims` row and zero projection work items. A census
  query equivalent to `tests/workitems-migration-census.test.js` finds
  one work shape in the tree, not two; `state.workItems` for work ceases
  to be written (it may survive only as a derived read view during the
  transition window in §4, and is gone at the end of it).
- **Zero divergence, permanently, by construction.** The
  `work_item_board_divergence` reading is 0 in every room not because a
  monitor watches it but because there is nothing left to diverge:
  `server/work-item-board.mjs`'s sync, backfill, and repair paths are
  deleted, and a repo grep for `work_item_board_divergence`,
  `DIVERGENCE_REPAIR_NOTE`, and `syncWorkItemClaim` returns zero hits
  outside archive/history.
- **One create door.** Exactly one create route + one MCP create tool
  remain (the work-claims door). The browser form and the MCP work tools
  call that same door — no second write path exists to grep: one
  `POST /api/rooms/{roomId}/work-claims` create operation in
  `docs/openapi.yaml`, one catalog tool for work creation in the MCP
  snapshot.
- **One receipt per completion.** New completions mint exactly one
  public receipt id, `wcr_` (the claim prefix — the surviving record's
  prefix). A completed-then-read probe on an opted-in room returns
  exactly 1 public receipt row for the completion (today's de-dup branch
  exists precisely because the naive count is 2). Pre-unification `wir_`
  ids keep resolving forever (see §4 Step 5): old links never 404.
- **One needs-you list.** Overview / Catch up / Decisions / What needs
  me and the `needs-me` read all derive from the claim record alone:
  `openWork`, `reviewAsks`, `myWork`, `myClaims`, `actionsNeeded` keep
  their names and shapes, but no section reads `state.workItems`. The
  measured needs-me performance bar from the consult-build wave is not
  regressed: memoised repeat reads stay in the ~1 ms class PR #5137
  achieved (107.8 ms → 0.9 ms;
  `~/workspace/wave-2026-10-27-consult-build/SYNTHESIS.md`, NM lane) —
  acceptance re-measures against the composed head, it does not trust
  this number.
- **No double checking.** Claim/lease/overlap rules execute in exactly
  one place (the claim state machine). The sync-time second enforcement
  (holder/caps refusals inside `syncWorkItemClaim`) is gone with the
  sync; a conflicting claim attempt gets one 409 from one layer.
- **History and ids survive.** Every pre-cutover work item is readable
  after cutover as a claim with its history, verification, delivery and
  chain intact (the existing mapping in `boardClaimForWorkItem` is the
  migration, run once as a final backfill — its idempotency property,
  "re-running the backfill over an unchanged room produces byte-identical
  rows and the second run writes nothing", is the acceptance shape).
  `boardClaimId` pass-through ids do not change, so existing `rc_`
  member receipts and claim ids keep working.

Exemplar worth matching: the module's own backfill discipline — a pure
mapping function shared by migration and live path so both converge "by
construction" — applied in reverse: instead of converging two stores
forever, converge once and delete the second store.

## 4. The instruction

**Gate (Step 0a — before anything else).** Confirm, in writing in the
build PR body: (i) Jill has re-chartered the typed-object phase and
lifted the seq-20696 hold; (ii) PRs #3556, #3629 (with its stack #3641 /
#3652 / #3714), #4002, #5038 are MERGED at the API (`gh pr view`), or
Jill has dispositioned each unmerged one by name. If any is still bound
and open, STOP — unification rebases their surfaces and landing them
afterwards would void their records. This piece is **schema + work-state
semantics: freeze-class. It lands singly, green at exact head**, never
in a Rules-v2 batch, and fix lanes never merge it.

**FORK — John's, pending, do not cross.** Decision (a) from the wave
brief: the two-tier verified-delivery vocabulary (mirroring
`hash_only` / `system_checked`). Receipt *id* unification (`wir_` →
`wcr_` canonical, `wir_` as a permanent resolve-alias) is mechanical and
in scope. Any change to verification *tier names, states, or what a
tier promises* is NOT: if a step appears to require one, stop that step
at the fork, ship the rest, and record the fork in the PR body for John.
Decision (b) (sponsor human surface) is not touched by this piece at
all — no step below restores, moves, or references it.

**Step 0 — Census at the unpause base (no code changes).** Re-run the
shape census at the then-current main: `tests/workitems-migration-census.test.js`
plus a fresh enumeration, filed in the PR body, of: every writer of
`state.workItems`; every reader combining both stores (start from
`needs-me.mjs`, `public-read-model.mjs`, `work-claim-routes.mjs`,
`available-work.mjs`); the exact `request_runs` and bounty link fields
(unverified in §2.5/§2.6 — settle them here); the Board v2 tables Claude
called dead, named table-by-table with a row count each; and every
client surface feeding on either store (Overview / Catch up / Decisions
/ What needs me / Board), named by file. If the census contradicts §1/§2
of this pack materially, stop and return to Jill before building.

**Step 1 — Field-parity pin (tests first, no behaviour change).** Extend
the census test so every work-item field with a reader is either (a)
present in the claim field set (`WORK_CLAIM_FIELDS` in
`server/work-claim-sqlite.mjs` / `workOf` output), or (b) named in an
explicit drop list with its reason (the existing precedent: session
counters `round_count` / `tool_calls` / `suspended_by` deliberately do
NOT move — they are event-derived and re-derive keyed by claim id;
`work-item-board.mjs` header, lines 14–18). The pin must fail if a new
work-item-only field appears. This step is its own small PR and may land
ahead of the rest once the gate passes.

**Step 2 — Final backfill + freeze the projection write path.** Bump the
backfill version (`WORK_ITEM_BOARD_BACKFILL_VERSION`, and the #3629
slice's version-2 fields if it landed as a separate version constant),
run `backfillAllRoomsWorkItemBoard` semantics one final time over all
rooms so every live work item has its board row, and verify per room:
divergence table reads 0 and a second run writes 0 rows (existing
idempotency property). Then flip the write path: the command layer stops
writing `state.workItems` for work and stops calling
`syncWorkItemClaim`; the 12 `WORK_ITEM_BOARD_SYNC_TYPES` events either
become claim-native events in the typed-object family (Claim objects,
per the redesign synthesis) or are emitted by the claim registry
directly. Keep `syncWorkItemClaim` present but unreachable for exactly
one release as the rollback leg; say so in the PR body.

**Step 3 — One create door.** Route the browser work-item form and the
MCP work tools through the work-claims create path
(`POST /api/rooms/{roomId}/work-claims` + its hosted-MCP twin). Creating
work that used to arrive as `work.proposed` now creates a claim
directly, preserving: title/criteria/tags/files inputs, the room config
caps (`maxOpenClaims`, `maxMemberOpenClaims` — enforced once, in the
claim layer), and the wake behaviour in `server/work-wakes.mjs`. Remove
the reducer's work-item creation branch only after the form and tools
are switched and their tests pass against the claim door. Any client
change is vanilla JS, incremental (settled constraint — no framework,
no door rebuild).

**Step 4 — One needs-you list.** Re-point `server/needs-me.mjs` and
`server/available-work.mjs` so every Board-derived section
(`openWork`, `reviewAsks`, `myWork`, `myClaims`, `actionsNeeded`) reads
the claim registry only; delete any code path that reads
`state.workItems` for work. Section names, item shapes, cursor
semantics, and the memoisation keyed on board version (PR #5137's
design: room-set version incl. an exact board-version counter + validity
horizon — preserve it; a sequence-only key is a known-stale defect)
must not regress. Client surfaces confirmed in Step 0 (Overview /
Catch up / Decisions / What needs me) switch to this single list in the
same PR or a named follow-on client PR by the client implementer (§6).

**Step 5 — Receipt unification.** `server/public-read-model.mjs`: public
receipts project from claims only (`wcr_`); delete the work-item loop
and the de-duplication skip that existed to suppress the mirrored
claim's second row. `wir_` becomes a permanent **resolve alias**: the
public receipt read accepts a `wir_` id and resolves it to the same
completion's `wcr_` row (the deterministic hash inputs survive — keep
`publicWorkItemReceiptId` as a resolver, not a projector).
`server/work-claim-routes.mjs`: the member receipt keeps `rc_<id>`
(ids are claim ids now — unchanged for pass-through ids) and its twin
lookup tries `wcr_` first and the `wir_` alias second. Do NOT touch
verification tier vocabulary (FORK above). Opt-in/public-exposure
semantics are unchanged: check the room's authoritative setting, never
a projection row (the settled-lot RCA lesson, restated in the current
code comment at `work-claim-routes.mjs` lines 495–505).

**Step 6 — Link the adjacent records (additive only).** Reply requests
that ask for work create or link a claim: when a `room_request_reply`
ask is work-shaped, the request run records the resulting `claimId`
(extend `request_runs` additively — new nullable column/field, no
rewrite of existing rows). Bounties get the same treatment at the link
level only: a bounty may record a `claimId` for its underlying work.
**Non-goal / hard stop:** no change to bounty money semantics, escrow,
claimant rules, or settlement — if linking appears to require one, stop
that sub-step and record it; money work is separately chartered and
lands singly.

**Step 7 — Delete the duplication machinery.** After Steps 2–5 have been
live for one release with divergence at 0: delete
`server/work-item-board.mjs`'s sync/backfill/repair machinery (the whole
module if nothing else imports it — `boardClaimId` moves to
`server/work-claims.mjs` or wherever Step 0 found its remaining callers,
behaviour byte-identical, its existing tests re-pointed not rewritten);
drop or retire the `work_item_board_backfill` and
`work_item_board_divergence` tables through the store-registry path
(§5), and disposition each Board v2 table named in Step 0 (drop only
with a row count of 0 or an archived export named in the PR body —
never on the unverified "dead" assertion alone). Remove the projection
work-item store/read paths left dead by Steps 2–4.

**Explicit non-goals.** No React/framework or client rebuild; no
verification-vocabulary change (John's fork); no sponsor surface; no
bounty money/escrow/settlement change; no change to lease defaults,
claim caps, or review policy semantics (the bound PRs in §1 own those);
no storage/SPILL interaction (claim rows already live in SQLite, outside
the 4 MiB room projection — removing projection work items only shrinks
the projection); no new identities or task engine (redesign constraint:
bind to existing identities).

**Sequence summary.** Gate → Step 0 census → Step 1 parity pin (own PR)
→ Steps 2+3 (one singly-landed server PR: freeze + one door) → Step 4
(server + client follow-on) → Step 5 (receipts, same or next singly-
landed PR) → Step 6 (additive links, may batch as ordinary work once
the freeze-class core has landed) → Step 7 (deletion PR, after one
clean release). No step starts while the previous step's acceptance
(§5) is unrun.

## 5. Acceptance

The coordinator/Jill accepts from these checks alone, run at the exact
head of each step's PR (Ruling 41 does not apply — this is schema /
shared-core semantics, so evidence binds to the **exact head**, and each
PR lands **singly** with the `ready-to-land` label added once):

**Executed checks (commands / suites by name).**

1. `node ~/workspace/fleet-tools/registration-sweep.mjs --range <base>..<head> --repo-dir <checkout>`
   — exit 0, no MISSING (see sweep items below).
2. `npm run verify:affected` — exit 0; **plus**, because the diff touches
   `server/**`: `CI=1 npm run check` — exit 0.
3. Named suites, all green at the exact head: `tests/workitems-migration-census.test.js`
   (updated pin), the `tests/board-*.test.js` family (incl.
   `board-native-record`, `board-projection`, `board-needs-me`),
   `tests/available-work.test.js`, `tests/agent-work-claimable.test.js`,
   the work-claim suites selected by `verify:affected` for
   `server/work-claims.mjs` / `server/work-claim-routes.mjs`, the
   needs-me family, and the public-receipts / public-read-model suites.
   A suite that cannot run locally is NAMED in the PR body (VM EPERM
   episodes make hosted CI at the exact head the evidence — say which).
4. Migration probe (Step 2): on a production-shaped fixture room set,
   run the final backfill twice — first run creates the expected rows,
   second run writes **0 rows**; `workItemBoardDivergence` equivalent
   reads **0 diverged in every room** after run one.
5. Door probe (Step 3): create one work item via the browser-form path
   and one via the MCP tool against a test room — each yields exactly
   **1** `work_claims` row and **0** new `state.workItems` entries;
   `grep -rn "work.proposed" server/ src/` shows no remaining work-item
   creation branch (or the Step-0-named survivor, with reason).
6. Receipt probe (Step 5): complete one claim in an opted-in test room;
   the public receipts read returns exactly **1** row for that
   completion, id prefix `wcr_`; the pre-cutover-style `wir_` id for a
   migrated completion still resolves (HTTP 200, same completion), and
   a member `rc_` receipt for it carries a non-null public twin.
7. Needs-you probe (Step 4): `needs-me` response for a fixture identity
   contains the claim in exactly one of `openWork` / `myClaims` as
   appropriate, byte-same section shapes as pre-change fixtures, and a
   memoised repeat read measures in the same order as the pre-change
   head (report both numbers; regression >10× is a reject).
8. Deletion grep (Step 7): `grep -rn "syncWorkItemClaim\|work_item_board_divergence\|DIVERGENCE_REPAIR_NOTE" server/ src/ tests/`
   returns hits only in the migration/census history the PR body names.
9. Post-landing (John's Tab, §6): after deploy, read-only GETs of
   `/api/public/receipts` on both production doors return 200 and a
   known pre-cutover `wir_` receipt URL still resolves.

**Registration-sweep items (per ~/AGENTS.md "Pre-flight registration
sweep").**

- **Runtime-package closure — REQUIRED** if any new `server/**` module
  is added or a module's import graph changes (expected: `boardClaimId`
  relocation in Step 7; claim-door wiring in Step 3): allowlist in
  `scripts/runtime-package.mjs` incl. full import closure +
  `scripts/candidate-runtime-fixture.mjs`, verified by the closure test.
- **Error-code catalogue, both copies — REQUIRED** if any refusal is
  added/removed/re-mapped (expected: sync-time refusals
  `work_claim_conflict` / `work_board_full` / `too_many_open_claims`
  change home or shape in Steps 2–3): row in
  `skills/project-room/references/errors-catalog.md`, then
  `node scripts/skills-sync.mjs` so the `plugins/` mirror is
  byte-identical. Removing a code also triggers the refusal-shape step:
  grep the test tree at head for old-shape pins and report them as
  REQUIRED-review evidence.
- **Route triple — REQUIRED.** Create-door removal/consolidation and any
  needs-you route change touch `server/routes/table.mjs`, the
  legacy-allowlist baseline (if on the legacy chain), and
  `docs/openapi.yaml` (operation + bare-path quickstart example); every
  changed route row carries its parity note (`parity: "mcp:<tool>"` or
  `exempt:<reason>`); a new mutating operation declares a well-formed
  `x-room-permission` marker.
- **Harness copy sets — REQUIRED if applicable:** any module a test
  harness copies/transforms (work-claim / needs-me modules are harness
  staples) gets wired into that harness's copy/re-point set; if no
  touched module is harness-copied, mark n/a with the grep that proved
  it.
- **Store registries — REQUIRED.** This is a schema change: retiring
  projection work items and the backfill/divergence tables (Step 7) and
  the additive `request_runs` link (Step 6) require writer-fence +
  purge-registry + recovery-audit registration for every added/dropped
  table, and additive sidecars partition in `verifySchema`. The two
  lazy tables (`work_item_board_backfill`,
  `work_item_board_divergence`, currently in
  `server/writer-fence.mjs` `lazyAdditiveTables`) are deregistered in
  the same diff that drops them.
- **Generated/mirrored artifacts — REQUIRED.** Event-family changes
  (Step 2) re-size EVENT_TYPES / EVENT_CATALOG and
  `webhook_subscribe`'s inputSchema → regenerate
  `tests/fixtures/mcp-catalog.snapshot.json` in the same diff; MCP
  catalog growth/shrinkage also moves the COUNT PINS in
  `tests/mcp-search-actions.test.js` +
  `tests/mcp-untrusted-content.test.js` (run both by name —
  `verify:affected` does not select them). OpenAPI fragment changes
  (fragments 0113–0128 / 0141 area) regenerate `docs/openapi.yaml`
  through its generator, not by hand.
- **Diff hygiene — REQUIRED in practice:** this work will exceed 300
  changed lines per PR; every PR body carries the
  `## Large diff justification:` section at filing, plus the Step-0
  gate confirmations (§4) and any suite named-not-run.

## 6. Routing

- **Primary implementer: Codex** — server/core work (store, claim state
  machine, migration/backfill, route triple) is his map, and the
  freeze-class landing runs from John's Mac under his release seat.
  Handover channel: `room_request_reply` to Codex's room member with a
  concrete ask, the `workItemId` of the (single, claim-door-created)
  charter item for this piece, and the expected result ("Steps 0–3 PR,
  singly landed, acceptance §5 items 1–6 green at exact head"). All
  Codex utilisation stays inside Project Room. Note the irony and use
  it: the charter for this unification is itself created through the
  current doors and becomes a Step-3 test case.
- **Client surfaces: Claude** — Board / Overview / Catch up / Decisions
  / What needs me vanilla-JS changes (Step 4 follow-on) ride his own PR
  train; he is also the design author of this piece, so design disputes
  route to him first, as design input, not as a second build.
- **Landing seat: Grok Bot** (with John's Tab) — stack/slot order and
  the singly-landed freeze-class merges; fix lanes never merge.
- **Post-deploy verification: John's Tab** — acceptance §5 item 9
  (both production doors, receipts read + legacy `wir_` resolution).
- **Browser evidence: Fo** — responsive duty / browser-shard evidence
  for the client follow-on PR (Board and needs-you surfaces).
- **Jill's fleet** — verification, settle passes, cures, and the §5
  acceptance runs; never merges. Jill owns the gate: unpausing the
  typed-object phase and lifting the seq-20696 hold is the first
  acceptance act, and no other implementer may treat this pack alone
  as that lift.

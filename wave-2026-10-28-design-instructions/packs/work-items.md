# Instruction Pack — Work Items (lifecycle: create, claim, deliver, review)

Slug: `work-items` · Wave: `wave-2026-10-28-design-instructions`
Target tree: **main `aaa749065a6451321a949ddcb923f3174504fe35`** (verified by
`git archive` of that SHA into lane scratch, 2026-10-28; the shared clone was
NOT read as main). Production runs `ca37fee4` and is NOT the target except for
the post-deploy probe in §5. Two parts are gated: §4 Step 4 stops at a JOHN
fork, and §4 Step 6 is **EXECUTABLE-AT-UNPAUSE ONLY** (typed-object phase
PAUSED, FOCUS-REVIEW). Everything else is executable now, after the bound
predecessor in Step 0 lands.

## 1. The piece

"Work items" is **two linked records for the same work**, and the pack covers
both plus their sync. Do not collapse them except under Step 6.

**A. Room work items** (event-sourced, in the room projection
`state.workItems`, cap `PILOT_LIMITS.workItemsPerRoom = 500`,
`server/store.mjs:450`):

- Vocabulary + reducers: `src/events.js` — `WORK_STATES` = `proposed →
  accepted → working → blocked → completed`, plus `superseded` (line ~507);
  event types `work.proposed / accepted / started / blocked /
  blocker_resolved / completed / superseded / handoff_recorded /
  halt_cleared`, `claim.acquired / released / renewed`,
  `verification.recorded`, `owner.decision_recorded` (lines ~65–82).
  Reducer logic: `src/work-reducers.js` (`proposeWork, acceptWork, startWork,
  blockWork, completeWork, supersedeWork, acquireClaim, releaseClaim,
  renewClaim, recordVerification, recordOwnerDecision, …`); history/change
  derivation: `src/workflow.js` (`workItemChanges`).
- Store reads: `server/store.mjs` — `workItemHistory(token, roomId,
  workItemId, …)` at line 4839, `workContext` 5584, `workDiscussion` 5596,
  `workResult` 5619; HTTP doors in `server/http.mjs` (the `commands` POST and
  the `work-context / work-discussion / work-result / work-changes /
  work-sessions` GET routes, regex at line 3862).
- Client surfaces: `src/app.js` — propose via `draftCommand(…, T.WORK_PROPOSED,
  …)` (~line 6137) and the accept/complete action dialogs (~line 6168, the
  complete dialog demands signed-evidence JSON); board: `src/board.js`,
  `src/board-ui.js`, `src/board-mine.js`.

**B. Board work claims** (the anti-collision claim store; `work_claims` table
is source of truth, `work_claim.updated` is the thin room record):

- Pure state machine: `server/work-claims.mjs` (1,817 lines) — `STATES =
  unclaimed, claimed, in_progress, blocked, delivered, done, closed`;
  `CLAIM_LIFECYCLE` table (state × verb → next; `done`/`closed` terminal);
  `createWork` 1048, `claimWork` 1088, `renewWork` 1141, `updateWork` 1242
  (start/block/finish→`delivered`/verify→`done`/changes_requested→
  `in_progress`/release), `recordReview` 1495 (verdicts `approve,
  changes_requested, comment`), `releaseWork` 1422, `closeWork` 1440,
  `reassignWork` 1611, `releaseExpired` 1659. Leases: default 24 h, cap
  168 h, per-room `roomWorkClaimConfig`. Delivery bundle = `{ artifact,
  checks, criteria }` via `deliveryOf()`; digest frozen at finish
  (`deliveryDigest`); verify runs platform checks `bundle_integrity,
  criteria_coverage, ci_settlement` (`executeDeliveryChecks`).
- Routes: legacy chain in `server/http.mjs` lines 3957–3971 —
  `GET/POST /api/rooms/{roomId}/work-claims`, `…/status`, `…/sweep`,
  `…/duplicates`, `…/config`, `GET …/work-claims/{claimId}`, `POST
  …/{claimId}/claim|update|review|release|reassign|renew`, `GET
  …/rooms/{roomId}/receipts`; handler + `receiptOf()` in
  `server/work-claim-routes.mjs`. New-style table routes:
  `server/routes/work-claims.mjs` (`WORK_CLAIM_ROUTES`: read, retention,
  close, cancel, provenance/premise-invalid).
- Agent doors: `client/work-actions.mjs` (MCP `room_claim` with
  `action=take|renew|release`, successors of `room_acquire_claim /
  room_renew_claim / room_release_claim`), `client/room-agent.mjs`
  (`renewWorkItem`, ~line 985), `client/public-work-claims.mjs` (public-work
  sibling — adjacent, NOT this piece's store), `server/routes/agent-work.mjs`
  (`GET …/agent-work`, pickup observation only).

**C. The sync:** `server/work-item-board.mjs` — `boardClaimId(workItemId)`
keys the board row; one-way item→board sync (`syncWorkItemClaim`,
`WORK_ITEM_BOARD_SYNC_TYPES`, wired in `server/store.mjs` ~6307);
divergence is persisted in `work_item_board_divergence` and repaired by
backfill (`backfillRoomWorkItems`, `DIVERGENCE_REPAIR_NOTE`).

**Bound PRs for this piece (checked in
`landing-watch-bindings.json`, 2026-10-28):**

- **#4973 — BOUND, SETTLED-GREEN, record `ce187c20`, bound head
  `13a944ecad6e56ff1bc13c8f43e083c0e4d28a6c`.** The `workItemId` index:
  additive expression index `events_room_work_item` on `events(room_id,
  json_extract(body,'$.data.workItemId'))` in `server/store.mjs`
  (`ensureWorkItemEventIndex()` beside `ensureEventTypeIndex()`), and
  `workItemHistory`'s scan pinned `INDEXED BY events_room_work_item` via
  `WORK_ITEM_HISTORY_EVENT_SQL`. **SCHEMA surface: lands singly; record is
  VOID if the head moves.** §4 instructs only what remains after it.
- **#5015 — BOUND, SETTLED-GREEN, record `28d670b7`, bound head
  `c99dcee8f7f0b836dcd0f73a5fbd0560a5970bb8`.** Content is ONLY the flake
  registry: 7 entries in `tests/quarantine.json`, `repair_by 2026-11-10`.
  It contains **no renew fix and no renew-probe entry** — see §2. Do not
  amend it (a head move voids its record); any new registry entry rides a
  follow-up PR after it lands.

## 2. Current state

Executed / on-file evidence only; anything else is marked UNVERIFIED.

1. **History reads scan every event in the room (cured only on paper).**
   At main `aaa749065a`, `workItemHistory` (`server/store.mjs:4848`) still
   runs `SELECT body FROM events WHERE room_id=? AND
   json_extract(body,'$.data.workItemId')=? ORDER BY sequence` with no
   index — verified by reading the archived tree and by grep: zero hits for
   `ensureWorkItemEventIndex`, `events_room_work_item`, or
   `WORK_ITEM_HISTORY_EVENT_SQL` anywhere in `server/ src/ tests/` at that
   SHA (the #4973 test file does not exist at main either). #4973's PR body
   carries the measurement: 100 k events / one room, median **708.48 ms
   before → 0.06 ms after** (pinned plan), and 828 ms with the index present
   but the statement unpinned — the pin is load-bearing.
2. **The renew probes are skipped, ownerless, and contradict shipped pins.**
   Housekeeping Q3 (`wave-2026-10-27-housekeeping/lanes/Q3/REPORT.md` §"The
   2 skips, in detail"; synthesis §Q3): the only 2 static `test.skip` in the
   whole tree are `MUT-04-A/B` in `tests/work-claim-renew-probes.test.js`
   (lines 23, 36), skipped **since 2026-10-08**, in-file note "this test
   FAILS on current code — the footgun is live … kept skipped until the
   renew semantics are decided"; no `owner`, no `repair_by`, outside the
   quarantine registry's contract, already past the registry's 14-day cap.
   Fresh executed check by this lane at main `aaa749065a` (2026-10-28):
   `node --test tests/work-claim-renew-probes.test.js
   tests/work-claim-renew-probe-b.test.js` → **1 pass, 2 skipped, 0 fail**.
   The contradiction is real, not a bug typo: `renewWork`
   (`server/work-claims.mjs:1141`) documents and implements "starts a fresh
   lease window from now", defaulting an omitted `leaseHours` to the room
   default (24 h); `tests/lease-renewal.test.js:182–187` pins exactly that
   ("renewWork starts a fresh lease window from now … the room's default
   24h"), and `tests/work-claim-renew-probe-b.test.js` pins the consequence
   (a smaller renewal **shortens** an unexpired lease) as "a conscious
   design decision". The skipped probes assert the opposite on both points
   (A: omitted duration keeps the original 6 h duration; B: explicit
   duration stacks on the old expiry). Semantics are **undecided**, and
   #5015 does not decide them — it only makes the registry non-empty.
3. **Delivery silently discards worker content (EXECUTED, UT2).**
   UT2 lane 03-05 (`wave-2026-10-27-user-testing-2/lanes/
   03-05-worker-delivery-edges/REPORT.md`; ROLLUP §03-05): **D1 S2** — a
   bundle carrying `artifact.content` (the actual work), `artifact.surprise`
   and a delivery note was accepted with **200**, and the stored delivery
   contains none of them, with no warning on any surface — success response,
   content gone. **D2 S3** — `artifact.kind` is length-only validated
   (`kind:"banana"` delivered and stored verbatim). **D4 S3** — after a
   `changes_requested` send-back, re-delivery **overwrites v1 wholesale**;
   the v1 bundle survives on no read surface (claim read, history, receipt);
   `deliveryGeneration: 2` is the sole trace. Re-delivery while `delivered`
   is correctly refused 422, and post-`done` is immutable (same report).
4. **The delivery bundle is undiscoverable before you deliver (EXECUTED).**
   Same lane: the claim read, board list and activation pack state **none**
   of the bundle requirements; curated OpenAPI omits the work-claims routes;
   only `llms-full.txt`'s closing-rules paragraph states them. Measured
   cost from zero knowledge: **6 sequential refusals**, each revealing one
   requirement. Counterweight: UT2 03-02 (ROLLUP) — the claim→work→deliver→
   approve happy path is the cleanest in the product when the caller already
   knows the shape: 7 transition calls, all first-try 2xx.
5. **FORK — "verified" overclaims (John's decision, §4 Step 4).**
   UT-conversion charter `charters/verified-delivery.md` §§1–2, executed
   twice (production + kernel): a bare-filename artifact whose bytes the
   platform never received closes as `verification.state:"verified"` with
   platform `executedChecks: bundle_integrity: pass, criteria_coverage:
   pass` — both checks run over bundle *metadata*, never artifact bytes.
   Public work already has the honest two-tier vocabulary
   (`hash_only | system_checked`, `server/public-work-reviews.mjs`); room
   claims do not. The charter's fence (§4) forbids a lone lane "fixing"
   this by special-casing bare filenames.
6. **Two chartered gaps, neither built.** (a) Removed-member recovery
   (UT-conversion `charters/removed-member-recovery.md`; lane E REPORT
   §15-3): claims of a removed member stay theirs, and a release via
   `updateWork → unclaimed` **clears a `delivered` claim's delivery
   bundle** — silently destroying money-adjacent work awaiting review;
   removal has ≥5 paths with no single hook. Leg (b) was explicitly NOT
   built. (b) Claim-expiry warning (`charters/claim-expiry-warning.md`):
   expiry is passive (`releaseExpired`/`sweepRoom` on next touch); the
   holder's first signal is the loss (Fo's panel report, room seq 19947).
   The charter fences the shape: warning as an event on the room sequence,
   **never** a per-claim timer, and it must be scheduled against the wake
   rebuild, not parallel to it.
7. **The two stores diverge by construction (design input, PAUSED phase).**
   Claude's input (`pr-redesign-2026-10-23/
   DESIGN-INPUT-claude-work-claims-2026-10-27.md`): same work stored twice,
   one-way sync, no write-back on board claim/deliver → divergence +
   repair reopens; two create doors, two receipts (`wir_` / `wcr_`),
   assignment/overlap checked twice. Jill's disposition there: design
   input only, hold stands. UT-conversion REPORT:65 adds the read-side
   symptom: `room_list_work` lists work items only and `openClaims` admits
   only `unclaimed` rows, so a returning agent cannot see claimed /
   in-progress / blocked / delivered claims in one list.

## 3. What fantastic means

Concrete, checkable end state for a stranger and for a working agent:

- **History is instant at scale.** `workItemHistory` on a 100 k-event room
  answers in **≤5 ms median** on the #4973 fixture method (bound PR measured
  0.06 ms), with `EXPLAIN QUERY PLAN` showing `SEARCH … USING INDEX
  events_room_work_item` — no room-size cliff on the most-read lifecycle
  surface.
- **Zero skipped lifecycle probes.** `tests/work-claim-renew-probes.test.js`
  contains **0 `test.skip`**; renew semantics are stated in one docstring,
  pinned by exactly one consistent suite set, and any future skip anywhere
  in this piece carries an owner + `repair_by` in `tests/quarantine.json`.
  A holder renewing a 6 h lease is never silently surprised: the response
  and the claim read show the new `leaseExpiresAt` and which rule produced
  it, before the old expiry passes.
- **No silent delivery loss, ever.** A deliver call either stores every
  field it accepted or refuses **422 naming the offending field** — the
  UT2 03-05 D1 bundle (extra `artifact.content`, unknown key, stray note)
  can no longer return 200 with content dropped. Every superseded delivery
  generation stays **readable** (claim read + receipt): generation *n*'s
  artifact ref, sha256, checks and criteria are retrievable after
  generation *n+1* lands; a dispute about what was first submitted is
  settleable from platform records alone.
- **First-try delivery.** Everything needed to deliver is on the claim read
  *before* claiming: required bundle fields, criteria count, sha format,
  review policy. Zero-knowledge deliver goes from **6 sequential refusals
  to 0** (the bundle is fully specified up front; refusals remain for
  actual violations). The happy path stays at UT2 03-02's standard: every
  transition first-try 2xx.
- **The word "verified" means what a stranger thinks it means** — per
  John's Step-4 decision: either tiered (`hash_only`/`system_checked`
  mirror) or carrying a visible `artifact_receipt: skipped` executed check
  whenever bytes were never received. No surface shows plain `verified`
  for a bare filename with no qualifier.
- **Nobody loses work by leaving or by silence.** A removed member's
  `delivered` claim is never auto-cleared; it is parked for a named
  reviewer with its bundle intact. A lease holder gets **one T-30 min
  warning per claim round** naming claim, holder, absolute expiry and the
  renew action.
- **(At unpause only)** One work record: divergence snapshot reads
  `diverged = 0` structurally — there is no second store to diverge from.

## 4. The instruction

Work in order. Steps 0–3 and 5 are separate PRs; do not batch them.
Money/shared-core/schema discipline: anything touching `server/store.mjs`
schema or the proof vocabulary lands **singly, green at exact head**;
fix lanes never merge.

**Step 0 — Land #4973 first; build nothing for the index.**
The index is done and bound. The landing seat lands #4973 at its bound
head `13a944ec…` (record `ce187c20`); if the head has moved, the record is
void — return to a settle pass, do **not** rebase or rebuild it yourself.
After it lands, the verifier (not the lander) confirms §5's index checks
on the new main, then Steps 1–3 may start against that main.

**Step 1 — Decide renew semantics on the record, then make the tests say
exactly that (one PR, tests + `server/work-claims.mjs` only if Branch B).**
This is a Jill/coordinator decision (delegated), NOT a John's fork and NOT
the implementer's silent choice — the verified-delivery charter §3 names
choosing policy inside a test file as the failure mode to avoid.

1. Before touching code, obtain the decision as a dated record (room Record
   or the PR body, quoting it verbatim) choosing:
   - **Branch A — AFFIRM shipped semantics.** Fresh window from now;
     omitted `leaseHours` → room default; a smaller renewal may shorten.
     This matches `renewWork`'s docstring and both pinning suites.
   - **Branch B — CHANGE semantics.** Omitted `leaseHours` keeps the
     claim's original lease duration (probe A), and/or an explicit
     duration stacks on the old expiry (probe B). Treat A and B-probe as
     separately choosable; the record must rule on each probe individually.
2. Branch A implementation: delete the two skipped probes from
   `tests/work-claim-renew-probes.test.js` and replace them with unskipped
   pins of the affirmed semantics in the same file (probe A's pin asserts
   the room-default result; probe B's duplicates
   `work-claim-renew-probe-b.test.js` — so instead delete probe B there and
   keep the hardening file as the single pin). Update the file header so
   no reader can mistake the footguns for live bugs.
3. Branch B implementation: change `renewWork` only (plus the route-layer
   lease handling in `server/work-claim-routes.mjs` and the event-sourced
   `claim.renewed` reducer path in `src/work-reducers.js` /
   `tests/lease-renewal.test.js` if the ruled probe touches it); unskip
   the ruled probes; **flip** the contradicting pins in
   `tests/lease-renewal.test.js` (line ~182) and
   `tests/work-claim-renew-probe-b.test.js` in the same PR, with the
   decision record quoted in the PR body; update `renewWork`'s docstring
   and the `room_claim` tool text in `client/work-actions.mjs` to match.
4. Either branch: if any probe is still skipped 14 days after the charter
   starts, register it in `tests/quarantine.json` (owner + `repair_by`)
   in a follow-up PR — #5015's bound head must not be amended (§1).
   Note the #5015 clock: its 7 entries carry `repair_by 2026-11-10`;
   that is the registry owner's problem, not this step's, but do not let
   this step's PR touch `tests/quarantine.json` before #5015 lands.

**Step 2 — Delivery integrity: no silent discard, generations retained
(one PR; `server/work-claims.mjs`, `server/work-claim-routes.mjs`).**
Failing-first, from the UT2 03-05 executed shapes:

1. Strict bundle keys: `deliveryOf()` / the artifact codec refuses any
   key outside the documented bundle shape (`artifact{kind,ref,sha256}`,
   `checks`, `criteria`, and the update-level `note`/`deliveryMode`/
   `tags`/`blobs`) with **422 `invalid_claim_input` naming the field**
   (reuse the existing code — see §5; do not invent a new one). A caller
   who wants inline content gets the refusal telling them to use a ref +
   sha256, or the public-work `artifactText` door — never a 200 that
   drops it. `artifact.kind` stays a caller label (length-validated), but
   the claim read and receipt must render it as caller-asserted (same
   honesty rule as Step 4's surface leg; do not invent a kind allowlist —
   PR/merged/production kinds are open-ended by design).
2. Retain generations: on a `changes_requested` re-delivery, the prior
   bundle is preserved before replacement — append it to the claim's
   history stamp payload (or an additive `deliveryHistory` array shaped
   like the existing `rework_json` precedent in consult-build #5136) with
   its digest and generation number, and expose all generations on the
   claim read and in `receiptOf()`. Cap retained generations at the
   existing `MAX_CLAIM_HISTORY` discipline; never retain by inflating the
   hot room projection (board rows are side-table state, keep them there).
3. Tests first: new/extended suite(s) replaying D1 (unknown fields → 422
   named), D2 (kind stored verbatim, labelled caller-asserted), D4
   (v1 readable after v2, digests distinct, generation = 2).

**Step 3 — State the bundle up front (one PR; routes + client board).**
Add a `deliveryRequirements` object to the claim read and board list
payloads (`buildWorkClaimPage` in `server/work-claim-routes.mjs` /
`getWorkClaimsRead` in `server/routes/work-claims.mjs`) whenever the item
carries acceptance criteria or a non-`self_attested` policy: required
artifact fields, sha256 format, criteria count + ids, the review policy,
and whether a bundle is required or optional. Mirror the same object in
the activation pack (`server/room-activation-pack.mjs`) and render it on
the board claim detail (`src/board-ui.js`) in vanilla JS. Add the
work-claims routes to the curated OpenAPI (`docs/openapi.yaml`, bare
paths) so the machine schema exists outside `llms-full.txt`. No new
route, no new event type.

**Step 4 — FORK (JOHN'S decision (a): verified-delivery vocabulary).
STOP HERE until the decision is recorded.**
Do not build any part of this step, and do not smuggle a ref-shape refusal
in as a substitute (charter fence). When John rules, implement exactly
the ruled branch of `wave-2026-10-27-ut-conversion/charters/
verified-delivery.md` §5:

- **Branch A (two-tier):** room claims adopt a tier mirroring public
  work's `hash_only | system_checked`; `verified` is reserved for
  deliveries with at least one platform-executed check over the artifact
  itself (received bytes, settled CI bound to the delivery, or a
  poller-verified PR outcome). Old `verified` rows keep reading; the tier
  stamps at verify time only. Touch list is the charter §3 list:
  `VERIFICATION_STATES`/`verificationOf()`, `bindReviewerRequestOutcome`,
  `receiptOf()`, `server/receipts-page.mjs` (`verificationLabel`), the
  `llms-full` closing-rules text in `server/agent-discovery.mjs`, and
  `tests/verified-state-deception-canaries.test.js`. Proof-layer change:
  lands singly, green at exact head.
- **Branch B (surface honesty):** keep `verified`; add the
  `artifact_receipt` executed check reporting `skipped` with the
  charter's detail text whenever bytes were not received, rendered on
  the receipt's plain surface next to the word.
- Branch C (platform-received bytes required) only if John explicitly
  picks it — it demotes PR/merged/production deliveries and is the
  largest build; re-charter before starting.

**Step 5 — Recovery + warning (two separate PRs, after Step 2; follow
the existing charters, do not redesign them).**
(a) Removed-member recovery per `charters/removed-member-recovery.md`:
hook claim release at the member-removal paths the charter enumerates;
`claimed`/`in_progress`/`blocked` release to `unclaimed` with lease and
owner cleared; a `delivered` claim is **never** auto-released or cleared
— it is flagged for a named reviewer with bundle intact (depends on
Step 2.2's retention). (b) Claim-expiry warning per
`charters/claim-expiry-warning.md`: T-30 min, one per claim round, as a
work-claim event on the room sequence via `emitWorkClaimEvent` /
`enqueueClaimWake` (`server/work-claim-events.mjs`); advisory only; no
timer/cron shape; coordinate the evaluator question (next touch vs sweep
vs wake evaluator) with the wake-rebuild owner before building, exactly
as the charter's §3 orders.

**Step 6 — EXECUTABLE-AT-UNPAUSE ONLY: one work record.**
Trigger: a recorded unpause of the redesign typed-object phase
(FOCUS-REVIEW pause lifted; cite the unpause record in the PR body — no
record, no start). Then implement Claude's design input (§2.7): make
`work_claims` the sole work record — one create door; work-asking reply
requests create/link a claim; board claim/deliver writes back natively
(no sync, no divergence table to repair); one "needs you" list feeding
Overview / Catch up / Decisions / What needs me (also curing §2.7's
read-side symptom). This is schema + money-adjacent proof work: it gets
its own charter, lands singly, and is NOT part of Steps 1–5 estimates.

**Explicit non-goals.** Rebuilding or amending #4973 or #5015; bounty /
public-work request-changes (owned by consult-build draft **#5136**,
queued for settle pass 22 — do not duplicate); the sponsor human surface
(John's fork (b) — deliberately deleted 2026-10-19; in-room work-claim
visibility already exists and this pack does not restore a sponsor
surface); React/any client rewrite (vanilla JS, incremental); new
receipt signing (the signer is unprovisionable today — Invariant 17 —
and nothing here may imply signed receipts); waking idle Codex sessions
(the tracked-ask protocol is unchanged).

## 5. Acceptance

Coordinator/Jill runs these at the source; a self-report gates nothing.

**Step 0 (post-land, on new main):**
`grep -rn "events_room_work_item" server/store.mjs` hits the ensure + the
pinned `WORK_ITEM_HISTORY_EVENT_SQL`; `node --test
tests/workitem-history-index.test.js` = 3/3 (index exists with exact SQL,
pinned plan SEARCHes both keys, pre-index store converges byte-identical);
named suites from #4973's body all green: `workitems-board-migration`,
`work-history`, `schema-stamp-coverage`, `writer-fence`,
`boot-corrupt-quarantine`, `bounty-journal-lot-state-index`,
`work-claim-history-spill`, `work-history-floor`. Spot-bench on the PR's
100 k fixture method: median ≤5 ms. Registration sweep for #4973 was the
settle pass's; re-verify item 5 (store registries): additive expression
index, no writer-fence change — confirm no fence/registry diff rode along.

**Step 1:** PR body quotes the dated renew-semantics decision verbatim,
ruling on each probe separately. `node --test
tests/work-claim-renew-probes.test.js tests/work-claim-renew-probe-b.test.js
tests/lease-renewal.test.js tests/work-claim-leases.test.js` — all green
with **0 skipped** (`grep -c "test.skip" tests/work-claim-renew-probes.test.js`
= 0); the pinning suites and the docstring agree with the decision (grep
`fresh lease window` / the new wording). If Branch B: `npm run
verify:affected` plus the claim-event suites (`work-claim-events`,
`claim-scopes`, `claims-index`).

**Step 2:** the new failing-first tests exist and pass (they must fail on
the pre-PR main — coordinator spot-checks one by `git archive` of the
base); full claim family green: `node --test tests/work-claim-*.test.js
tests/public-work-claims.test.js` plus UT-conversion Lane B's named set
(`work-claim-verified-state` 20, `work-claim-verified-routes` 33,
`work-claim-degraded`, `storage-failure` + `work-claims` 253 at their
2026-10-27 counts — report current counts, do not force the old numbers).
Live-shape replay of UT2 03-05 D1/D4 against a local server: unknown-field
bundle → 422 naming the field; v1 bundle still readable after v2.

**Step 3:** claim read for a criteria-bearing item contains
`deliveryRequirements` with every field the deliver door will demand
(coordinator diffs it against `deliveryOf()`'s checks by hand — the
zero-refusal claim); `docs/openapi.yaml` lists the work-claims routes;
board detail renders the object (Fo browser-shard evidence or a
board-ui suite pin).

**Step 4 (only after John's recorded ruling):** the deception canaries
(`tests/verified-state-deception-canaries.test.js`) pass at the ruled
semantics and a bare-filename delivery's receipt shows the ruled tier /
`artifact_receipt: skipped` on its plain surface — executed, not asserted.

**Step 5:** (a) suite per the charter §test shape: removed holder's
`claimed`/`in_progress` end `unclaimed` with null lease/owner; the
`delivered` claim is untouched, bundle byte-identical, reviewer flag set.
(b) warning fires once per round at T-30 min in a store-level test with a
fake clock; a renew starts a new round and re-arms; no new cron/timer in
the diff (`grep` the PR for `setInterval`/cron registrations = 0).

**Every step:** `npm run verify:affected` clean; for any `server/**`
diff also `CI=1 npm run check`; `npm run lint`. Registration sweep
(`~/AGENTS.md`, "Pre-flight registration sweep") per step:
1. Runtime-package closure — applies only if a step adds a `server/**`
   module (none planned; Steps 2/3/5 edit existing modules) — else n/a:
   no new module.
2. Error-code catalogue, both copies — n/a for Steps 1–3/5 (they reuse
   `invalid_claim_input` and existing codes); APPLIES to Step 4 if it
   adds a code, and to any step that finds itself wanting a new code:
   row in `skills/project-room/references/errors-catalog.md` + run
   `node scripts/skills-sync.mjs`, mirrors byte-identical.
3. Route triple — n/a: no step adds a route (Step 3 adds a payload field
   and OpenAPI documentation for existing routes; the OpenAPI part is
   still required). Step 4/6: re-evaluate at charter time.
4. Harness copy sets — APPLIES to Steps 2/5: the chaos harness generates
   a `work-claim-routes.mjs` copy at runtime (UT-conversion Lane B note);
   run the chaos/storage-failure suites by name, do not rely on
   verify:affected selecting them.
5. Store registries — n/a Steps 1–3/5 (no new table; Step 2's retention
   is an additive field on existing board rows — confirm `verifySchema`
   additive-sidecar treatment in the PR body). APPLIES to Step 0
   (checked above) and Step 6 (full registry pass at its charter).
6. Generated/mirrored artifacts — APPLIES to Step 1 Branch B and Step 3
   if MCP tool text/catalogue changes: regenerate
   `tests/fixtures/mcp-catalog.snapshot.json` and run
   `tests/mcp-search-actions.test.js` + `tests/mcp-untrusted-content.test.js`
   by name; Step 5b adds an event action — if `EVENT_TYPES` grows, the
   EVENT_CATALOG re-size + snapshot regen in the same diff is REQUIRED.
7. Diff hygiene — any PR >300 changed lines carries the
   `## Large diff justification:` section (Step 2 and Step 6 will).
8. Close-out — named suites above are the close-out; any suite that
   cannot run locally is NAMED in the PR body (EPERM/store-backed suites
   are CI's evidence — say so, per consult-build precedent).
9. Refusal-shape — APPLIES to Step 2 (it changes a 200 into a 422):
   grep the test tree at head for pins of the old silent-discard shape
   and report them as REQUIRED-review evidence in the PR body.

**Post-deploy (John's Tab, §6):** on production, in an own room:
create → claim → deliver (first-try, requirements read from the claim
read alone; count refusals — target 0) → changes_requested → re-deliver
→ read back v1 and v2 → approve → receipt shows the Step-4 surface (or,
pre-Step-4, the current `verified` wording — record which build,
`ca37fee4`-successor, was probed).

## 6. Routing

- **Steps 0/1/2/5a — Codex** (server/core: `work-claims.mjs` state
  machine, store, routes; he owns the claim/renew semantics context from
  the lease suites). Handover: `room_request_reply` to the Codex member
  with a concrete ask, this pack's path, a `workItemId`, and the expected
  result (one PR per step, failing-first tests named in §5). All Codex
  utilisation inside Project Room; the ask does not wake an idle session,
  so Jill posts it and waits for his attended pass. Step 0 itself is the
  **landing seat's** act: **Grok Bot** lands #4973 singly at its bound
  head under slot discipline (schema surface), with John's Tab on the
  merge-gate.
- **Step 3 — Claude** (client surfaces + payload presentation: board
  detail rendering, activation-pack copy, OpenAPI text) with Codex
  reviewing the server payload shape; rides Claude's own PR train.
- **Step 5b — Codex with the wake-rebuild owner** named in the charter
  (the event-sequence shape is theirs to co-sign before any code).
- **Step 4 — nobody**, until John's ruling is recorded; then Codex
  (proof layer, server) with Jill's fleet on the canary verification.
  **Step 6 — nobody**, until the unpause record exists; then re-charter
  to Codex + Claude jointly (his design input).
- **Verification — Jill's fleet** (settle/verify passes, cures; never
  merges) runs every §5 check at the source. **Fo**: browser-shard /
  board-render evidence for Step 3. **John's Tab**: post-deploy probe
  above, and John's two gates surfaced to him once — the Step 4 ruling,
  and (Step 6) the unpause, which rides the existing FOCUS-REVIEW gate
  rather than a new ask.

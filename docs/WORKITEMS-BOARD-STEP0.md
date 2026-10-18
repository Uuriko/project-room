# workItems → board claims — Step 0 characterization (charter B-4)

Status: **Step 0 complete. The council kill criterion is TRIGGERED — the
migration halts here and the council re-convenes with this census. No code
was cut, no mapping was improvised.** The write-path sync
(`syncWorkItemClaim`) stays, named and costed (§7), until the council
decides the fate of the orphaned state in §4.

Scope of this record: charter B-4 step 0 only — reader/writer census,
vocabulary mapping, field fates, and the verification/decision absorption
plan. Evidence is mechanical: `tests/workitems-board-step0-census.test.js`
pins every claim that can be pinned (site inventory, sync surface, field
fates, the live rework divergence) against a real `RoomStore`; the rest is
source-anchored. Base: `main` at the Step 0 branch point. Prior art this
builds on: `tests/workitems-migration-census.test.js` (item field
inventory, PR #3282) and `tests/workitems-board-migration.test.js`
(backfill + sync behavior).

## 1. The two vocabularies

### States

| workItem (`src/events.js` `WORK_STATES`) | board claim (`server/work-claims.mjs`) | mapping (`boardStateForWorkItem`) |
|---|---|---|
| `proposed` | — | **no card** (deliberate: an unclaimed card is claimable by the board's availability predicate; proposed work is not claimable until accepted) |
| `accepted` | `unclaimed` / `claimed` | `unclaimed`, or `claimed` while the embedded claim lease is live |
| `working` | `in_progress` | direct |
| `blocked` | `blocked` | direct |
| `completed` | `done` | direct |
| `superseded` | `closed` | direct, plus `supersededBy` + chain link |

Board-only states with no item source: none — but the board also carries
kinds `land` and `deploy`, which have no workItem analogue and are out of
scope. Item-only transition: **`completed → blocked` (rework)** — the
reducer retires the approval and re-blocks a completed item
(`src/events.js`, `retireApproval(..., "rework")`); the board lifecycle
makes `done` terminal (`CLAIM_LIFECYCLE.done = {}`). See §4.6: this is not
a theoretical gap, the two stores disagree on live rework today.
Item-only return: `blocked → accepted` on blocker resolution (the board
mapping emits `state:claimed`/`state:unclaimed` history stamps instead).

### Leases (two implementations, kept in agreement only by the sync)

Item: `item.claim { holderId, status, expiresAt, repository, ref, paths }`
(`server/claim-scopes.mjs` scope semantics on top). Board:
`leaseStartAt / leaseExpiresAt` + the engine's sweep. The mapping carries
holder/repo/branch/paths/lease across while a claim is live or the item
finished/blocked with it; a released claim on an unclaimed card is cleared,
matching the board's own release.

### Receipts (two)

Item receipt: the `work.completed` receipt object (§3). Board receipt:
derived at read time as `rc_<claimId>` from the claim row (history
`state:done` stamp + attestations). They name the same delivery with
different content: the board receipt cannot reproduce the item receipt's
signed evidence or checks (§4.4).

## 2. Census — every live reader and writer

Method: full-text scan for `workItems` over the shipped tree at the Step 0
base, pinned file-by-file in the Step 0 census test (55 files under
`server/` + `src/`; outside those trees: `client/` 2, `machine/` 1,
`cloudflare/` 4 check/fixture files, `scripts/` ≈60 operational and
browser-check scripts that consume the client/store shapes).

### Writers of `state.workItems`

| Writer | What it writes |
|---|---|
| `src/events.js` (reducer) | The only production writer: 16 work-related event handlers (`work.proposed/accepted/started/blocked/blocker_resolved/completed/superseded/handoff_recorded/halt_cleared/help_updated/public_set`, `claim.acquired/released/renewed`, `verification.recorded`, `owner.decision_recorded`, plus help-offer events touching item-adjacent state). The same reducer runs in the browser client. |
| `src/work-item-session.js` | `ensureWorkControlDefaults`: backfills `round_count / tool_calls / suspended_by` onto every item during replay. |
| `server/work-help.mjs` | Writes `helpWanted` onto projected state copies inside the help service (the durable write is the `work.help_updated` event through the reducer). |
| `server/store.mjs` (command layer) | Validates work commands, applies events, then calls the board sync at `store.mjs:5315-5316` for the 12 sync types; runs the one-shot backfill on open (`store.mjs:1900`) and exposes the shadow diff (`store.mjs:1920`). It does not write items directly. |

### The sync surface (exactly 12 event types)

`work.accepted, work.started, work.blocked, work.blocker_resolved,
work.completed, work.superseded, work.handoff_recorded, claim.acquired,
claim.renewed, claim.released, verification.recorded,
owner.decision_recorded` (`WORK_ITEM_BOARD_SYNC_TYPES`, pinned in the
test). Work-mutating events **not** synced: `work.proposed` (deliberate,
§1), `work.help_updated`, `work.public_set`, `work.halt_cleared` — the
last three carry state with no board field (§4.5).

### Readers, by family (all 55 pinned sites)

- **Kernel/reducer:** `src/events.js`, `src/workflow.js`,
  `src/work-item-session.js`, `server/claim-scopes.mjs`.
- **Store/command/recovery:** `server/store.mjs`,
  `server/work-item-board.mjs` (the mapping itself), `server/recovery.mjs`,
  `server/writer-fence.mjs`, `server/purge-registry.mjs`,
  `server/messages-store.mjs`, `server/message-redaction.mjs`,
  `server/content-trust.mjs`.
- **Discovery:** `server/available-work.mjs`, `server/opportunities.mjs`,
  `server/orient.mjs`, `server/room-activation-pack.mjs`,
  `server/needs-me.mjs`, `server/public-read-model.mjs`.
- **Attention:** `server/inbox.mjs`, `server/notifications.mjs`,
  `server/updates.mjs`, `server/owner-attention.mjs`,
  `server/owner-overview.mjs` (Owner Cockpit slice 1, PR #3572 —
  read-only cross-room fan-out over the per-room attention readers;
  recorded 2026-10-16),
  `server/reminders.mjs`, `server/reply-requests.mjs`,
  `server/return-brief.mjs`, `src/reminders.js`, `src/reply-requests.js`.
- **Work surfaces (server):** `server/work-context.mjs`,
  `server/work-discussion.mjs`, `server/work-help.mjs`,
  `server/work-wakes.mjs`, `server/mcp-room-profile.mjs`,
  `server/project-offers.mjs`, `server/public-work-reviews.mjs`,
  `server/spend-allowance.mjs`, `server/text-results.mjs`,
  `server/usage-summary.mjs`, `server/agent-fleet.mjs`,
  `server/agent-identities.mjs`.
- **Client:** `src/app.js`, `src/board.js`, `src/board-ui.js`,
  `src/conversation.js`, `src/growth-emit.js`, `src/help-offers.js`,
  `src/human-experience.js`, `src/portable-work.js`, `src/room-layout.js`,
  `src/room-templates.js`, `src/work-help.js`, `src/work-packet.js`,
  `src/work-recipes.js`, `src/work-selectors.js`.

Direct `state.workItems` reads concentrate in `server/store.mjs` (≈42
sites: validation, search, sessions, integrity) and `src/app.js` (≈40: the
human work surface). Reader migration is therefore not 55 equal jobs: the
long tail reads one or two fields (usually lifecycle state, receipt, or
help), and the two hubs read everything.

## 3. Field fates under the current mapping

Measured by driving a maximally populated item through the real store
(Step 0 census test, "fates" cases; sentinel strings prove absence from
the board row, not just from a field list).

| Item field | Board fate |
|---|---|
| `id` | survives as claim id via `boardClaimId` (injective encoding), plus `workItemId` back-link |
| `title` | survives |
| `state` | survives per §1, except `proposed` (no card) and rework (§4.6) |
| `labels` | survive as `tags` (pattern-filtered; item cap 10, board cap differs) |
| `proposedById` | survives only as the `created` history stamp's `agentId` |
| `createdAt / updatedAt` | survive (`updatedAt` from the item, keeping backfill idempotent) |
| `claim.holderId` | `owner` while claimed/working/blocked/done |
| `claim.repository / ref / paths` | `repo / branch / files(+fileBlocks)` |
| `claim.expiresAt / acquiredAt` | `leaseExpiresAt / claimedAt` |
| `receipt.summary` | the `state:done` history note + attestation note (receipts read the stamp) |
| `receipt.producerId` | attestation `memberId` |
| `receipt.evidenceUrl` | `evidenceRefs` (https only) |
| `receipt.evidenceVersion` | `blobs` (only when `sha256:<hex>`-shaped) |
| `verification` (result/summary/verifier) | a `reviews` entry (pass → `approve`, fail → `changes_requested`) + `reviewedBy` |
| `decision` (decision/reason/actor) | a `reviews` entry (approved → `approve`, else `changes_requested`) |
| `blocker.reason` (while blocked) | `premiseFlag.reason` + a `state:blocked` history note |
| `supersededBy` | survives + chain `supersede` link; successor card gets `dependsOn` (phantom card if cardless) |
| `handoff.nextAction` | the chain `handoff` link's note + a `<item>-next` phantom card |
| `independentVerificationRequired`, `verifierMemberId` (presence) | collapse into `reviewPolicy` (`independent_principal` / `distinct_member`) |

Caps that truncate in transit: item histories (receipt/verification/
decision, unbounded in the item) merge into board `reviews` (cap 50) and
`history` (cap 200, overflow counted in `historyOmitted`); evidence refs
cap 16, blobs cap 10, chain cap 20.

## 4. Orphaned live state — the kill-criterion evidence

Each entry: live state, its live readers, and why the board vocabulary has
no home for it. "Event-derivable" is noted where the event log (which the
migration keeps) could re-derive the value — the council's E6 precedent
accepted event-derivation for session counters (§4.7); whether it accepts
it for the rest is the re-convene question, not this record's call.

### 4.1 The work brief itself: `definitionOfDone`, `mode`
`definitionOfDone` is required at propose time and read by the MCP work
view (`mcp-room-profile.mjs`), `work-context.mjs`, opportunities,
public-read-model (public task list renders it), room export, templates,
and the human work card (`src/app.js`). The board row has **no
description/brief field at all** — `title` is the only text it carries.
`mode` (write/read — it decides whether a scope claim is required) is
likewise absent. An accepted item migrated today loses its brief.

### 4.2 Accountability and decision routing (identity fields)
- `accountableMemberId` survives only while the item is claimed/working/
  done (as `owner`). On an **accepted-but-unclaimed** item the board row
  has `owner: null` — measured in the Step 0 test. The accountable member
  is who needs-me, reminders, and wakes address.
- `verifierMemberId` survives only as a `reviewPolicy` kind; the identity
  is gone until a review actually happens (then it is `reviewedBy`).
- `humanDecisionMakerId` and `ownerDecisionRequired` have no board field
  in any state. The decision gate's addressee exists only on the item.

### 4.3 Verification semantics: `independenceConfirmed`, bindings
Item verification is designated-verifier-only, bound to a specific
completion event (`completionEventId`) and evidence version, and the
reducer *computes* `independenceConfirmed` (producer ≠ verifier, exact
receipt); approval semantics in the reducer and the client read that bit.
The board review records `{ memberId, verdict, summary, url, at }` only —
no independence flag, no completion binding, no evidence version (a
version reaches `blobs` only coincidentally, via the receipt). This is
the §5 absorption problem.

### 4.4 The receipt payload: signed evidence and friends
`receipt.signedEvidence` (the full `room-signed-evidence/1` object:
signer identity, content hash, signature) has no board field — measured:
the signature string is absent from the board row. Also dropped:
`receipt.checksClaimed`, `receipt.segments`, `receipt.producerAttribution`,
`receipt.nextAction`, and the receipt's `eventId` binding (the board
attestation keeps only member/time/summary). The board's `rc_<claimId>`
receipt is a different, weaker proof than the item receipt it would
replace.

### 4.5 Whole unsynced subsystems: `helpWanted`, `publicTask`, halt state
- `helpWanted` (+ help offers): set by `work.help_updated` (not a sync
  type), read by opportunities (it *is* the help discovery feed),
  work-help, needs-me, and the client. No board field, no board event.
- `publicTask`: set by `work.public_set` (not synced); it is the public
  board's opt-in linkage, read by public-read-model. A proposed item —
  the normal case for a freshly published task — has no board card at
  all, so there is nowhere for the linkage to move to without changing
  the proposed/no-card rule.
- Handoff detail beyond `nextAction`: `doneSummary`, `limitReason`,
  `evidenceUrl/evidenceVersion`, `haltAll` (+ `work.halt_cleared`),
  `triageMemberId`, `open` — the chain note keeps only `nextAction`.
  `blocker.nextAction` drops the same way (§3).

### 4.6 The rework transition (live divergence, measured)
Drive an item to `completed`, then `work.blocked`: the item goes
`blocked`; **the board row stays `done`** — the planner flags the row
diverged (`done` vs mapped `blocked`) and the sync leaves diverged rows
alone by design. So on live rework the two stores do not merely have
different vocabularies, they *disagree*, and any board-only reader (the
post-migration world) would report finished work that its owner has
re-opened. A mapping for rework cannot be a field mapping: the board
lifecycle itself refuses the transition.

**Disposition (2026-10-16): repaired.** Appendix D §D.2 ruled this
divergence a live proof-layer defect — escalate, repair, monitor;
"tolerate" was not an available ruling. B-4′ Phase 0 slice 1 (#3607)
implemented the transition-lite repair: a planner-classified `rework`
row (board `done`, the item provably completed before, the item now
mapping to a non-terminal state) reconciles to the mapped row with an
explicit divergence-repair stamp after `state:done`, and in the sync a
rework primary flows through the normal write/event path instead of
the silent skip. `board_native` divergences (foreign-owner active
claims, closed mismatches, unprovable cases) keep the refusal exactly —
forcing those rows stays prohibited. A per-room divergence snapshot
(the §D.2.3 monitor) counts both classes; zero is the only healthy
value, and any non-zero reading re-opens the defect. The census
divergence pin now records the repaired behavior; the deep contract
(sync end-to-end, backfill repair, classification proof rules) is
pinned in `tests/workitems-board-divergence.test.js`.

### 4.7 NOT orphaned (named derivations / acceptable homes)
- Session counters `round_count / tool_calls / suspended_by`: no board
  field, by E6's ratified decision — sessions are event-derived and
  re-derive keyed by claim id. Not a kill-criterion trigger.
- `sourceMessageId`: carried on the `work.proposed` event; event-derivable.
- `claim.releasedAt / renewals / overlaps / progressMessageId`,
  `revision`: lifecycle bookkeeping either superseded by board history
  stamps or owned by the board row's own revision counter.

## 5. Verification / decision absorption plan (input to the council, sequenced with #3546)

The council's rule: do not migrate the noun and invent the verified state
in the same step. Absorption therefore sequences **after** #3546
(delivered→verified board state) and #3547 (proof-carrying submissions),
and its shape is a council decision informed by §4.3–4.4:

1. #3546 lands a board `verified`-class transition whose actor is a
   designated verifier, bound to the delivery it verifies. Until then the
   board has no verb that means what `verification.recorded` means.
2. The absorption step then maps: item verification → that transition,
   carrying `independenceConfirmed`, `completionEventId`, and
   `evidenceVersion` as first-class fields (none exist on board reviews
   today); item owner decision → a second, distinct gate (the board's
   review verdicts conflate verifier and decider into one `reviews` list —
   §3 — while the item keeps them separate with separate addressees,
   §4.2).
3. The item receipt's signed-evidence object (§4.4) needs a board home
   (#3547's proof-carrying shape is the natural candidate) before
   `work.completed` can stop writing item receipts; otherwise the
   migration downgrades the product's proof layer, which the product
   decision (receipts as the proof layer) forbids.
4. Only after 1–3: reader migration in family batches (discovery →
   attention → work surfaces → client), dual-read shadow-diff per family
   via the existing `diffRoomWorkItems`, then sync deletion as its own
   final PR, then the `work_item_board_backfill` marker retirement behind
   the writer-fence/stamp procedure.

Estimated remaining envelope if the council supplies the missing
vocabulary: within charter B-4's 70–110 lane-hours. If it does not, the
honest end-state is the sync, kept and costed — not a forced fit.

## 6. What the council is asked to decide (re-convene input)

For each orphan in §4, one of: **(a)** extend the board vocabulary (name
the field/transition and which charter step owns it), **(b)** accept
event-derivation (the value is read from the room event log post-migration;
the item projection dies but the log stays), or **(c)** retire the feature
with the noun (name the user-visible loss). The blocking set is §4.1
(brief), §4.5 (help + public linkage), and §4.6 (rework) — those three
have live readers and no plausible (b) reading that keeps today's
behavior, because their readers need current state, not history.

## 7. The cost of staying (why this is a decision, not a shrug)

The sync runs inside `store.command()` on every one of the 12 sync event
types: each such command re-plans the room's whole board mapping
(`planWorkItemBoardBackfill` over all items + events) inside the write
transaction. Every new claim feature is implemented twice or diverges
(§4.6 is the divergence, already live). Step 0's recommendation is only
that the council pick §6 dispositions deliberately — the current state
was itself picked by accumulation, and its price is paid per command,
forever, until someone does.

## Alignment

Charter B-4 (redesign council, 2026-10-15): step 0 characterization,
capped at 15 lane-hours; budget envelope 70–110 lane-hours across slices;
kill date 2026-10-29 for step 0. This record + the pinned census test are
step 0's deliverable. Kill criterion — "step 0 finds live workItem state
with no claim-vocabulary home and no acceptable mapping → migration halts
at characterization, council re-convenes with the census; the sync stays
(named, costed) rather than a forced fit" — is **triggered** by §4.1,
§4.5, and §4.6 (with §4.2–4.4 as supporting orphans). Tracking: #3221
item 3. Slices after step 0 do not start until the council re-convenes.

### Message-domain extraction (2026-10-18)

`src/message-reducers.js` now owns the existing message reducers' work-item
references: proposal context, evidence immutability checks, and receipt text
withdrawal on delete/redaction. These moved from `src/events.js`; field fates and
board synchronization semantics are unchanged. The reference-site inventory adds
this module. This extraction does not complete the work-item/board migration.


## 2026-10-18 lifecycle integration amendment

The live reference-site census is now 58 files. `src/work-reducers.js` owns the
existing work lifecycle transitions extracted from `src/events.js`; the event
coordinator composes those reducers with the same authority guards. No work
fields, event semantics or persistence owners changed in that extraction.

The board mapper now retains board review/attestation basis, claimRound and
linked PR polling outcomes. A board delivery (including its retained send-back
record) is protected as board-native divergence when the work projection cannot
reproduce it. Work completion is not fabricated from board verification. The
remaining field losses above still prohibit replacing work items with claims.
The event-fact reader uses the existing event-type index and retains mapping
parity; whole-room mapping and serialization remain open architecture work.

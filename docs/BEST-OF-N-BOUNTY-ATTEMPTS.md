# Best-of-N bounty attempts — design spec

**Status:** spec for issue #3527. Not implemented. Per the issue, this spec
is reviewed before any build issue is filed; nothing in the "Proposal"
sections is code, a route, or a commitment to build it exactly as written.

**Code citations** are to `origin/main` at
`cef1c096485db09699931287437d26abfaf473a6` (2026-10-17), read in the run
that produced this spec. File/line citations name the file and the function;
line numbers are those of that revision.

**Home:** product design specs live in `docs/` beside the documents this
one builds on (`docs/BOUNTY-MCP-TOOLS.md`, `docs/BOND.md`,
`docs/SPEND-PRIMITIVE.md`, `docs/WORKITEMS-BOARD-STEP0.md`). The protocol
draft under `spec/` is not the home: `spec/README.md` states that draft
"does not define payments, credits, bounties, or payouts."

## 1. Decided scope (not open for redesign)

The following are decided in issue #3527 under John's standing delegation
(2026-10-15). This spec implements them; it does not revisit them.

- **D-1.** Max **3 concurrent attempts** per bounty.
- **D-2.** Attempts are **isolated** from each other; no attempt sees
  another's work in progress.
- **D-3.** The **poster picks the winner; escrow pays the winner only.**
- **D-4.** Losing attempts **remain visible to the poster and room
  members as branches of the work item** (learning + audit), **not
  publicly by default**.
- **D-5.** The **dispute flow applies to the winning attempt only.**
- **D-6.** The **per-room attempt cap can be revisited after first use**;
  3 is the launch default.

Everything after this section is **proposal** — the mechanism this spec
proposes for realising D-1..D-6 against the current code, plus the build
gaps where the current code cannot express it. Where a proposal needs a
decision at review time, it is marked **[review decision]**.

## 2. Verdict on the current code (falsifier check)

Falsifier for this lane: "the decided scope is already implementable
end-to-end in current code." **It is not.** The bounty record is a
single-attempt record by construction:

- `bounty_records` (schema in `server/bounty-escrow.mjs`,
  `bountyEscrowSchema`) has exactly one `claimant`, one `state`, one
  `amount_millis`, one `evidence_json`, one `attestation_json`, one
  `submission_hash`, and one `dispute_id` per bounty. There is no attempt
  row, attempt id, or attempt collection anywhere in the schema.
- `BountyEscrow.claimBounty` (`server/bounty-escrow.mjs:1696`) refuses a
  second claim outright: if the bounty is `claimed` it fails with
  `already_claimed` ("this bounty is already claimed", line 1736).
- `BountyEscrow.submitWork` (line 1767) requires `bounty.claimant === lane`
  and a single `claimed -> submitted` transition; a second submission has
  nowhere to land and would overwrite the one `evidence_json`.
- `BountyEscrow._viewBounty` (line 1289) projects exactly one claimant and
  one evidence object; `src/bounty-board.js` (`normalizeBounty`,
  `reviewHtml`) renders exactly one claimant, one delivery, one review
  panel per bounty.

What already exists and is reused unchanged by the proposal (§8) is
substantial — the award locks once, bonds are per-lot journal movements,
acceptance is rubric-cited, and disputes are already winner-shaped — but
the attempt itself is a new object. The build gaps are listed in §9;
none of them is papered over below.

## 3. Terms

- **Bounty** — the existing escrow record (`bounty_records`), posted and
  funded once, carrying the one award.
- **Attempt** — *(new, proposal)* one lane's run at a funded bounty,
  identified by an `attemptId`, holding its own bond lot, its own
  submission evidence, and its own outcome. An attempt is **not** the
  "attempt" of `src/work-item-session.js` (`attemptLedger`,
  `attemptReceipts`): that word already names a work-item *session* run
  (performer, environment, spend). A build must keep the two objects
  distinct in code and UI copy, or rename one of them. **[review
  decision: naming]**
- **Winner / loser** — the attempt the approver accepts / every other
  attempt on the same bounty. "Loser branch" is D-4's word: a retained,
  member-visible attempt record, not necessarily a git branch (see §7).

## 4. Claim and lease interaction

### 4.1 Two claim systems exist today; attempts belong to the escrow one

1. **Escrow claim.** `claimBounty` is the bounty claim: it checks the
   poster is not self-claiming, runs the reputation gate
   (`claimEligibility` in `server/bounty-reputation.mjs`, called before
   the write transaction), applies the anti-flake ladder (`_flakeState`:
   cooldown at rung 3+, double bond at rung 2+), locks the claim bond
   (`CLAIM_BOND_MILLIS` = 1000 milli-credits = 1 credit, times the ladder
   multiplier) as a `bond-lock` journal movement under its own `lot_`
   id, and sets the single claimant. It has **no lease**: the only time
   bound is the bounty's `deadline_ms`, checked at claim and at submit.
2. **Board work claim.** `server/work-claims.mjs` (`claimWork`,
   `renewWork`, `releaseExpired`) is a different machine: one holder per
   item, a lease (default 24h, `DEFAULT_LEASE_HOURS`; max 168h), and a
   sweep that returns lapsed claims to `unclaimed`.

**Proposal.** An attempt *is* an escrow claim, generalised from one
claimant to N. The attempt inherits the escrow claim's time model — the
shared bounty deadline, no per-attempt lease — and does not acquire a
board work claim. The board interaction is specified in §4.3.

### 4.2 Attempt claim rules (proposal)

- A bounty opts into attempts at post time (new flag on the bounty;
  default off). A non-opted bounty keeps today's exact behaviour,
  including the `already_claimed` refusal. This keeps every existing
  consumer — notably the public-work settlement rail (§4.4) — on the
  single-claim path unless it opts in.
- Claiming an opted-in, `funded` bounty creates an attempt instead of
  moving the bounty to a single claimant, provided:
  - the lane is not the poster (existing self-claim refusal in
    `claimBounty`);
  - the lane passes the same reputation gate and anti-flake ladder,
    evaluated per attempt (both already key off the lane, not the
    bounty, so they compose unchanged);
  - the lane has no other live attempt on this bounty (**one live
    attempt per lane per bounty** — required by the bond accounting in
    §5.3, not an arbitrary restriction);
  - the concurrent-attempt count — attempts in `active` or `submitted`
    (§6.1) — is below the effective cap. At the cap the claim is refused
    with a new error, proposed `attempt_cap_reached` (HTTP 409, the
    status `already_claimed` maps to in
    `server/bounty-escrow-routes.mjs`).
- Effective cap = the per-room cap (D-6; launch default **3**, decided),
  stored as room config. **Gap:** the escrow has no per-room config
  namespace today. The pattern to follow is the board's:
  `roomWorkClaimConfig` (`server/work-claims.mjs:966`) reads
  `room.workClaims` (caps included: `maxOpenClaims`,
  `maxMemberOpenClaims`) from the raw room config
  (`server/work-claim-sqlite.mjs`, `configFor`). Proposal: a sibling
  `bountyAttempts` config key with one field, `maxConcurrentAttempts`,
  validated 1..3 at launch (raising the ceiling above 3 is D-6's
  post-first-use revisit, not a launch feature).
- Each attempt claim locks that lane's own claim bond, exactly as
  `claimBounty` does today — same amount, same ladder multiplier, same
  `bond-lock` kind, its own lot id (§5.2).
- **Attempt window.** Attempts may be claimed while the bounty is
  `funded` and before `deadline_ms`. **[review decision]** Proposal:
  claiming stays open after the first submission — a late attempt races
  the same deadline as everyone else — and closes only at the deadline,
  at winner selection, or when the cap is full.
- **Withdrawal and expiry.** An attempt lane may withdraw before
  submitting; **[review decision]** proposal: withdrawal returns the
  bond in full and records no flake (it is a release, not a miss). An
  attempt still `active` at the deadline is a no-submit attempt and
  takes the existing timeout treatment (§5.4). A lane whose attempt has
  ended (withdrawn, expired, not selected) may claim again if a slot is
  free; each re-claim is a new attempt with a new bond.

### 4.3 Board work claims and file leases: the collision the build must not create

Parallel attempts deliberately work on the *same* work, often the same
files. The board machinery forbids exactly that, three times over:

- `claimWork` refuses any item not `unclaimed`; the route answers a
  second holder with HTTP 409 `work_claim_conflict`
  (`server/work-claim-routes.mjs`, claim handler).
- `fileLeaseConflicts` (`server/claim-coordination.mjs:348`) refuses a
  claim whose declared files overlap another live claim's files with
  HTTP 409 `file_lease_conflict`.
- `conflictingClaim` (`server/claim-scopes.mjs:34`) refuses an
  overlapping work-item claim reservation (`claim.acquired`) on the
  same repository + ref + paths with HTTP 409 `claim_conflict`.

**Proposal.** Attempts do not take board claims, file leases, or claim
reservations at all; the attempt record is the coordination object, and
the bounty board is the surface. A build that instead maps attempts
onto board claims must first add an attempt-scoped exemption to all
three checks — that is a larger, riskier change and this spec does not
propose it.

One lease hazard is named for the build regardless of that choice:
`releaseExpired` (`server/work-claims.mjs:1606`) clears a lapsed claim's
delivery, verification, CI, files, reviews, and attestations. If attempt
delivery were ever stored *only* on a lease-held board claim, a lease
lapsing mid-review would silently discard a submitted attempt. Attempt
submissions therefore live on the attempt record (§7), never solely on a
leased board claim.

### 4.4 Public-work rail is out of launch scope (proposal)

`PublicWorkSettlement.attachSubmission`
(`server/public-work-settlement.mjs`) settles a paid public task by
calling `claimBounty` then `submitWork` on its linked escrow bounty,
and refuses a second attached submission (`settlement_already_attached`).
That 1:1 offer↔bounty link assumes a single claim. Proposal: rail-linked
bounties cannot opt into attempts in v1, and the attempt-claim path
refuses them with an explicit error rather than corrupting the rail's
accounting. Widening the rail to best-of-N is a separate spec.

## 5. Escrow accounting for N attempts

The conservation invariant is the design constraint: balances are
derived from the append-only `bounty_journal`, and
`payable + locked + attributed + approved = total_issued` holds by
construction (`BountyEscrow.verifyConservation`, line 3177). Every rule
below is chosen so that check — including its per-bounty award-coverage
arm — still passes without weakening it.

### 5.1 The award locks once, never per attempt

`fundBounty` (line 1535) moves the full `amount_millis` from the
poster's `payable` to the poster's `locked` as one `escrow-lock`
movement and transitions `proposed -> funded`. That is the only award
lock in the lifecycle, and the proposal keeps it the only one:

- Attempts lock **no award**. An attempt is a bond plus a submission;
  it creates no `locked` award lot.
- This is forced by `verifyConservation`: for a bounty in `funded`,
  `claimed`, or `submitted`, it requires the award-kind lots in
  `locked` to equal exactly `amount_millis`. Locking the award per
  attempt (3 × amount) or splitting it across attempts both fail that
  check. Award kinds are the closed set `AWARD_KINDS` (`escrow-lock`,
  `attribute`, `approve`, `payout`, `refund`, `fee`); bond kinds are
  deliberately outside it, which is what makes §5.2 safe.

### 5.2 What each attempt locks

At attempt claim, one `bond-lock` movement: the attempt lane's
`payable -> locked`, amount = `CLAIM_BOND_MILLIS` × the lane's flake
multiplier, under a fresh lot id, with `bounty_id` set. This is
byte-for-byte the movement `claimBounty` already makes; N attempts
produce N such lots, one per lane. The journal schema already supports
this — rows are keyed by entry, carry `lot_id`, `bounty_id`, and
`account_id`, and nothing in `_move`/`_append` assumes one bond lot per
bounty. Worst case under the launch cap: 3 bonds locked concurrently
(3 credits at rung 1, more only where a lane's ladder multiplier is
already 2×). No new money is minted and no poster's balance changes
after funding.

A claimant must have the bond in `payable` at claim time
(`_requirePayable`, as today); a lane that cannot cover its bond cannot
take an attempt slot.

### 5.3 Bond settlement must become lot-scoped (build gap)

`_settleClaimBond` (line 2746) settles by **aggregate**: it sums every
`locked` journal amount for `(bounty_id, claimant)` and moves that sum
to return or forfeit. With one attempt per lane per bounty (§4.2) the
aggregate equals that lane's one attempt bond, so today's helper stays
correct *per lane* — but it cannot express "return loser A's bond now,
keep winner W's bond locked until payout." The build must scope bond
settlement by attempt (equivalently, by the attempt's lot id) wherever
selection, payout, and dispute settlement touch bonds. Until it does,
no partial bond settlement is possible. This is gap **G-3**.

### 5.4 When money moves: the full attempt timeline (proposal)

| Moment | Award lot | Winner-attempt bond | Loser-attempt bonds |
| --- | --- | --- | --- |
| Post | nothing locked (as today) | — | — |
| Fund | poster `payable -> locked`, full amount, once (`escrow-lock`) | — | — |
| Each attempt claim | unchanged | that lane's bond locks (`bond-lock`) | that lane's bond locks |
| Each submission | unchanged — submission moves no money (as today) | unchanged | unchanged |
| **Winner selection** (§6) | `locked` (poster) `-> attributed` (winner), full amount (`attribute`, as in `acceptWork`) | stays locked (existing winner path) | **returned in full** (`bond-return`), in the selection transaction |
| Challenge window passes | `attributed -> approved` (`_approve`), then epoch sweep pays out net of the 1% room-pool fee (`_sweep`; `FEE_NUMERATOR/FEE_DENOMINATOR` = 1/100) | returned at sweep (`_settleClaimBond`, forfeit=false) | already returned |
| Winner disputed | finality frozen while disputed (`_requireFinalityMove`), settlement per §7.3 | per dispute outcome, as today | already returned; disputes never touch loser bonds |
| No winner by deadline, attempt submitted | award refunds to poster in full, no fee | n/a — every submitted attempt is a "loser without a winner": bond **returned**, no flake (the `_settleUnverified` precedent: work submitted, never verified — the miss is not the worker's) | same |
| No winner by deadline, attempt never submitted | award refunds to poster | bond **forfeited** to the pool + flake strike (the `_timeoutRefund` precedent) | same per attempt |
| Poster closes without selecting ("reject all") | award refunds to poster in full, no fee | **[review decision]** proposal: all *submitted* attempts settle as not-selected — bonds returned, no flake, no reputation signal. `rejectWork`'s bond-forfeit + flake treatment is for work *judged bad* against the rubric; "none of these wins" is not that verdict, and pricing it as one would tax entering a race. Unsubmitted attempts keep the timeout treatment above. | same |

Two invariants the build must test:

- **Terminal means empty.** `verifyConservation` flags any terminal
  bounty still holding a non-zero balance in `locked`/`attributed`/
  `approved` across *all* journal kinds for that bounty — bonds
  included. Winner selection, reject-all, and deadline settlement must
  therefore settle **every** attempt bond before or in the same
  transaction as the terminal transition; a stranded loser bond is a
  conservation violation, not a cosmetic bug.
- **One settlement record.** The bounty's free-miss settlement record
  (`_recordSettlement`: `verified-complete` / `failed` / `unverified` /
  `partial`) stays bounty-level and winner-shaped: selection records
  the winner's verdict; "no winner" records `unverified` (submitted
  attempts) as today. Per-attempt outcomes live on the attempt records
  (§7), not in a multiplied settlement vocabulary.

### 5.5 Fees, challenge window, dispute bond — unchanged amounts

- Fee: 1% of the winner's payout to the room pool, only on a released
  payout (`_sweep`). Losers are never fee'd; there is nothing to fee.
- Challenge window: starts at winner acceptance, as `acceptWork` sets
  `challengeEndsMs` today — 3 days (`CHALLENGE_WINDOW_MS`), 24h for
  bounties under 1 credit (`CHALLENGE_WINDOW_SMALL_MS`).
- Dispute bond: exactly 25% of the bounty
  (`DISPUTE_BOND_RATIO` = 0.25; `disputeBounty` requires
  `bondMillis === ceil(amount_millis × 0.25)`). The amount the poster
  locked is still the single award, so the 25% is computed on the same
  base as today.

## 6. Winner selection

### 6.1 Attempt and bounty states (proposal)

Attempt states (new): `active` (claimed, not yet submitted) ->
`submitted` -> `selected` (winner) | `not_selected`; from `active` ->
`withdrawn` | `expired` (deadline, no submission). `submitted` attempts
can also reach `not_selected` via reject-all (§5.4). Terminal attempt
states: `selected` (which then follows the winner's bounty lifecycle),
`not_selected`, `withdrawn`, `expired`.

The bounty keeps its existing state vocabulary (`BOUNTY_STATES`,
`stateGroup`). Proposal for the aggregate mapping:

- Attempts open: bounty stays in its funded/claimed display group; the
  attempt collection is the detail view. The build must not reuse the
  single-claimant transitions (`funded -> claimed -> submitted`) per
  attempt — N attempts would drive the one state field in conflicting
  directions. **[review decision]** the least invasive mapping is: the
  bounty record's `state` advances only on poster/verifier-level events
  (fund, selection = accept, reject-all = refund, deadline settlement,
  dispute, payout), and attempt progress is read from attempt rows.
- Selection puts the bounty in `accepted` with `claimant` set to the
  winner lane — from that instant, every existing downstream mechanism
  (challenge window, keeper `_keeperPass`, dispute, epoch sweep) sees
  the ordinary single-claimant bounty it already understands. The
  winner's attempt is the only attempt whose identity is promoted onto
  the bounty record.

**Keeper hazard (build gap G-8).** `_keeperPass` (line 2866) acts on
the bounty state alone: a bounty in `submitted` at the deadline is
settled unverified and refunded. In attempts mode the build must gate
every keeper arm on the attempt collection (e.g. "deadline reached AND
no selection AND at least one attempt submitted"), or one attempt's
submission state could trigger a bounty-level settlement while other
attempts are still live.

### 6.2 Who selects

The acceptance authority that exists today: `_mayApprove` (line 2104) —
the poster in `human` approval mode, the designated verifier lane in
`agent` mode, either for `legacy`; never the claimant. **Proposal:**
selection *is* acceptance, performed by that same authority, through
the same evidence discipline: `acceptWork` (line 2111) requires a
verifier attestation citing every pinned rubric criterion
(`citationsAgainstRubric` against the rubric pinned at fund time), and
selection of an attempt requires the same citations **for that
attempt**. The rubric does not change per attempt — one bounty, one
pinned rubric, N submissions judged against it.

### 6.3 Selection is one transaction (proposal)

Selecting attempt W must atomically:

1. run the acceptance transition for W (attestation + citations,
   recorded on the bounty as today: `attestation_json`,
   `challengeEndsMs` set);
2. move the award `attribute` lot to W's lane;
3. mark every other `submitted` attempt `not_selected` and every
   `active` attempt closed (no further submission accepted);
4. return every loser bond (§5.3's lot-scoped settlement);
5. emit the events in §6.5.

A selection that does 1–2 but fails 3–4 leaves rivals able to submit
against a decided bounty and strands their bonds. The build files this
as one escrow transaction, following the existing pattern that every
`BountyEscrow` write runs inside `store.transaction`.

After selection, submission is closed for all attempts, the cap no
longer matters, and no new attempt can be claimed (the bounty is no
longer `funded`).

### 6.4 Selection UX (proposal)

Surface: the existing bounty board (`src/bounty-board.js`, rendered
from `listBounties`). Today `normalizeBounty` produces one claimant,
one evidence, one `canReview` flag, and `reviewHtml` renders one
delivery plus per-criterion pass/fail selects and one "Accept & release
escrow" button. The attempt version, for an opted-in bounty:

- **Attempt branches list.** Under the bounty row, one branch card per
  attempt: lane, attempt state, submission time, and — for viewers
  authorised under §7.1–7.2 — the evidence summary, evidence link, and
  claimed checks (the `_evidenceOf` shape: `evidenceUrl`,
  `evidenceKind`, `summary`, `checksClaimed`, `producerId`).
- **Compare before choosing.** Submitted branches render side by side
  (or as a switchable pair on narrow screens) with the pinned rubric
  criteria as rows, so the approver compares attempts against the same
  criteria they must cite. Each branch shows its submission fingerprint
  (`submissionHashOf` exists today for the single submission; per
  attempt it also powers the existing correlation/review-packet
  machinery in `_analyzeSubmissionCorrelation` — near-identical rival
  submissions are exactly what that machinery flags, and in a race that
  signal matters more, not less).
- **One select action per branch.** "Select winner" on a submitted
  branch, carrying the per-criterion verdict selects for *that*
  branch. The confirmation states the money plainly before commit:
  winner receives the award (net of the 1% pool fee at payout), every
  other attempt's bond is returned, no other attempt is paid. Buttons
  for unsubmitted branches are absent — there is nothing to judge.
- **Close without a winner.** A distinct "Close — no winner" action
  (the reject-all row of §5.4), labelled separately from rejecting an
  individual submission as bad work, because the money and reputation
  consequences differ.
- **Non-approver view.** Poster and room members who are not the
  approver see the branch list per §7.2 (in-progress branches as slots,
  §7.1), the selected winner once chosen, and retained loser branches
  after selection. Attempt lanes see their own branch in full.
- **MCP/API parity.** The hosted tools (`docs/BOUNTY-MCP-TOOLS.md`:
  `bounty_claim`, `bounty_submit`, `bounty_accept`, dispatched in
  `server/mcp-full-profile.mjs` and `server/bounty-escrow-routes.mjs`)
  gain attempt addressing: claim returns an `attemptId`; submit and
  accept name one. Agents are first-class attempt lanes and approvers
  (agent mode), so a board-only selection UX would strand them.

### 6.5 Events (proposal)

Existing event types cover the money (`bounty.funded`,
`bounty.accepted`, `bounty.paid`, `bounty.refunded`, …). New
attempt-scoped events, emitted through the same `_event` /
`bounty_events` stream and watcher fan-out (`watchBounty`,
`publishBountyEvent` in `server/bounty-escrow-routes.mjs`):
`bounty.attempt-claimed`, `bounty.attempt-submitted`,
`bounty.attempt-selected`, `bounty.attempt-not-selected`,
`bounty.attempt-withdrawn`, `bounty.attempt-expired`. Event payloads
follow the isolation rule in §7.2: an attempt-submitted event names the
attempt and its lane, never its evidence, until selection makes
branches member-visible.

## 7. Isolation, loser-branch retention, and disputes

### 7.1 What "isolated" must mean mechanically

D-2 is an information rule, not just a work rule. In the current
single-claim world isolation is free — there is only one submission.
With N live attempts, three leaks appear that the build must close:

1. **Evidence leak.** `_viewBounty` includes the parsed `evidence_json`
   in every bounty view, and `listBounties` (line 3002) returns views
   for the whole room — its own comment: "Bounties are never hidden."
   A rival who submits early would expose their delivery to attempts
   still working. **Proposal:** until selection (or deadline
   settlement), an attempt's evidence, summary, checks, and submission
   hash are visible only to (a) that attempt's lane, (b) the poster,
   (c) the designated verifier and dispute decider. Other lanes —
   including rival attempt lanes — see the branch as an occupied slot.
2. **Identity leak [review decision].** Proposal: rivals see the slot
   count ("2 of 3 attempt slots taken") but not *which* lanes hold the
   other slots, until selection. The poster and verifier see lane
   identities throughout (they must, to judge and to seat disputes).
3. **Event leak.** Watcher fan-out and the room event stream must not
   carry a rival's evidence payload (§6.5); state-change facts (a slot
   was taken, a submission landed) are safe to broadcast, content is
   not.

There is no execution-isolation mechanism to reuse or to promise: the
escrow never runs attempt work — evidence is an HTTPS URL plus summary
(`_evidenceOf`, line 2076) produced wherever the lane works. Isolation
in v1 is therefore **visibility isolation in the room**, and the spec
says so plainly rather than implying sandboxes the product does not
have.

### 7.2 Loser-branch retention (D-4)

After selection (or deadline/reject-all settlement), every attempt
record is retained as a branch of the bounty:

- **What is kept:** attempt id, lane, claim/submit timestamps, the full
  evidence object, the submission hash, the per-attempt outcome
  (`selected` / `not_selected` / `withdrawn` / `expired`), and the bond
  settlement (journal entry ids / lot id) so the branch is auditable
  against the journal. Retention rides the existing append-only pattern:
  attempt rows are written once per transition and never rewritten to
  hide a loser.
- **Who sees branches:** the poster and room members, through the same
  authenticated room surface as `listBounties` (the bounty routes run
  behind room auth in `handleBountyEscrow`,
  `server/bounty-escrow-routes.mjs`). At that moment the §7.1 in-progress
  restriction lifts for *submitted* branches: member-visible is the
  decided default (D-4). Unsubmitted branches show as slots with an
  outcome, there being no work to show.
- **Not public by default:** no loser branch is projected to any public
  surface. The signed-receipt machinery (`server/bounty-receipts.mjs`,
  `issueBountyReceipt`; the signable kinds are the `SIGNABLE_KINDS` map
  in `bounty-escrow.mjs` — `escrow-lock`, `bond-lock`, `attribute`,
  `payout`, `refund`) attests the bounty's money path, and under
  best-of-N only the winner ever reaches the award kinds (`attribute`,
  `payout`) that carry that attestation. Loser bond returns are
  `bond-return` movements — journal-only
  today, not signable — so a loser's branch is member-auditable without
  becoming a public receipt. A room-level opt-in to publish branches is
  **[review decision]** and out of v1 if the review does not ask for it.
- **How long:** branches live and die with the bounty record. There is
  no attempt-evidence deletion path in v1 (**gap G-12**): evidence is a
  URL + ≤2000-char summary + ≤50 short check strings (the `_evidenceOf`
  bounds), stored on the attempt row like `evidence_json` today. If a
  lane needs a branch's evidence link taken down, that is a poster /
  room-owner moderation action the build issue must name, or explicitly
  defer.

### 7.3 Disputes: winning attempt only (D-5)

This decided point is the one the current code already enforces
structurally, and the proposal is to keep the enforcement exactly
where it is:

- `disputeBounty` (line 2343) opens only on an `accepted` bounty —
  the #3726 Option A gate: disputes re-decide an *acceptance verdict*;
  submitted work has no verdict to dispute. It refuses any other state
  before the challenger's bond is checked or locked, refuses a second
  dispute (`dispute_exists` — the record carries one `dispute_id`), and
  refuses after the challenge window closes.
- Under best-of-N, `accepted` is reachable **only** through winner
  selection (§6.3), and the bounty's `claimant` at that point is the
  winner. A dispute therefore necessarily concerns the winning attempt:
  the challenger cannot be the winner (`lane !== bounty.claimant`
  check), the decider is seated by the existing path (designated
  dispute decider or verifier, `resolveTier1` in
  `server/dispute-arbiters.mjs`, with the seat-or-refuse rule), the
  pure machine is `createDisputes` in `server/bounty-disputes.mjs`,
  and settlement (`_settleDispute`, line 2568) moves the winner's
  attributed award and the winner's claim bond — loser bonds were
  already returned at selection and are out of the dispute's reach.
- Outcomes keep today's meanings for the winner: `release` (award
  vests, challenger bond compensates the winner or forfeits per the
  existing rules), `cancel` (full refund to poster, winner's claim
  bond forfeits, flake strike recorded), `split` (half vests, half
  refunds — the free-miss `partial` exception). The 14-day unresolved
  default is release (`DISPUTE_TIMEOUT_MS`, keeper arm in
  `_keeperPass`).
- **Loser attempts have no dispute path in v1 (proposal, stated
  plainly).** Not being selected is the poster's acceptance choice, not
  an acceptance verdict *for* the loser, so there is nothing for the
  dispute machine to re-decide; a selection cannot itself be disputed —
  a dispute challenges the winner's *work*, and overturning it refunds
  the poster rather than crowning the runner-up. **[review decision]**
  if selection is overturned by a cancel, proposal: the bounty ends
  `refunded`; it does not auto-promote a loser branch (their bonds are
  already returned and their work was judged in a closed round).
  Re-running the bounty is a fresh post/fund, or a successor task where
  the public-work pattern applies.

## 8. What already exists and is reused (no build)

- Award funding as a single lock: `fundBounty`; rubric pinned at fund
  time (`updateRubric` refuses after `proposed`; versions preserved in
  `bounty_rubric_versions`).
- Per-lane claim gates: poster self-claim refusal, reputation
  eligibility (`claimEligibility`), anti-flake ladder (`_flakeState`,
  `_recordFlake`, bond multiplier, cooldown).
- Bond journal movements and lot ids: `_move` with `bond-lock` /
  `bond-return` / `bond-forfeit` / `bond-compensate` kinds.
- Acceptance discipline: `_mayApprove`, rubric-cited attestation
  (`citationsAgainstRubric`), challenge window, `_approve`, `_sweep`
  with the 1% fee, signed winner receipts (`issueBountyReceipt`).
- Rejection and no-verdict settlements to mirror for attempts:
  `rejectWork`, `_settleUnverified`, `_timeoutRefund`.
- The whole dispute path of §7.3, including decider seating and the
  keeper's dispute-timeout arm.
- Conservation checking: `verifyConservation`, including the terminal
  "holds nothing" arm that §5.4 relies on.
- Watchers and the bounty event stream: `watchBounty`, `listEvents`,
  `publishBountyEvent`.

## 9. Build gaps (for the future build issue)

Each gap names the current-code fact that makes it a gap. The build
issue is filed only after this spec is reviewed (per #3527).

- **G-1 — Attempt storage and state machine.** `bounty_records` holds
  one claimant/state/evidence/attestation/submission-hash (schema,
  `bountyEscrowSchema`; `_saveBounty`/`_mutable` round-trip exactly
  those columns). Needs: an attempt table (or equivalent), attempt
  states (§6.1), and the aggregate mapping onto the bounty state.
- **G-2 — Attempt claim path and cap enforcement.** `claimBounty`
  fails the second claim with `already_claimed`. Needs: opt-in flag,
  per-lane live-attempt check, concurrent-count check against the
  per-room cap, new `attempt_cap_reached` refusal, attempt-scoped
  submit (`submitWork` keys off the single claimant today).
- **G-3 — Lot-scoped bond settlement.** `_settleClaimBond` aggregates
  by (bounty, claimant); selection/payout/dispute need per-attempt
  settlement (§5.3).
- **G-4 — Winner-selection transaction.** `acceptWork` accepts the one
  submission. Needs the five-step atomic selection of §6.3, including
  closing rival attempts and returning their bonds.
- **G-5 — Attempt-scoped visibility.** `_viewBounty`/`listBounties`
  expose evidence to every room reader; event fan-out carries event
  data room-wide. Needs the §7.1/§7.2 viewer-dependent projection for
  attempts (poster/verifier/self vs rival vs member-after-selection).
- **G-6 — Board and API/MCP attempt surface.** `src/bounty-board.js`
  models one claimant/evidence/review per bounty; the routes and MCP
  tools address bounties, not attempts. Needs branch list, compare,
  select and close-without-winner actions, and `attemptId` addressing
  in `server/bounty-escrow-routes.mjs` and
  `server/mcp-full-profile.mjs`.
- **G-7 — Per-room attempt-cap config.** No bounty-side room config
  exists; the cap (D-6) needs a home following the
  `roomWorkClaimConfig` pattern (§4.2).
- **G-8 — Keeper attempt awareness.** `_keeperPass` and `closeEpoch`
  decide from the bounty state alone (§6.1 hazard); deadline,
  unverified, and timeout arms must read the attempt collection.
- **G-9 — Conservation coverage for attempts.** `verifyConservation`'s
  per-bounty arms assume the single-claim lifecycle; extend its checks
  (and its tests) to prove §5.4's invariants with N live attempt lots:
  award locked exactly once, every attempt bond accounted for in every
  terminal state.
- **G-10 — Board-claim non-interaction.** Nothing today stops a build
  from wiring attempts onto board claims and hitting the three
  collision rules of §4.3 (or the `releaseExpired` delivery-clearing
  hazard). The build must implement §4.3's proposal — attempts
  coordinated by attempt records — or spec an exemption first.
- **G-11 — Rail exclusion.** `PublicWorkSettlement.attachSubmission`
  assumes one claim per bounty; the build must refuse attempts on
  rail-linked bounties (§4.4).
- **G-12 — Branch moderation/retention policy.** No deletion or
  takedown path exists for stored submission evidence (today's or an
  attempt's). The build names the poster/owner moderation action for a
  loser branch's evidence, or defers it explicitly (§7.2).

## 10. Review decisions collected

For the review this issue requires before a build issue is filed —
all are proposals above, none is decided scope:

1. Naming: bounty "attempt" vs the work-item session "attempt"
   (`src/work-item-session.js`) — keep both, or rename one (§3).
2. Slot visibility to rivals: count only, or lane identities too
   (§7.1).
3. Claiming after the first submission: stays open to the deadline
   (proposed) or closes at first submission (§4.2).
4. Withdrawal before submission: bond returned in full, no flake
   (proposed) (§4.2).
5. Reject-all: submitted attempts' bonds returned, no flake/reputation
   signal (proposed) (§5.4).
6. Bounty-state aggregate mapping: poster-level events only (proposed)
   (§6.1).
7. Dispute-cancel does not promote a runner-up (proposed) (§7.3).
8. Any room opt-in to publish loser branches publicly: out of v1
   unless the review asks for it (§7.2).

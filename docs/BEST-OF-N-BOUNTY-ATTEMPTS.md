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

The acceptance authority that exists today: `_[+16634 bytes at .content[1].resource.text]
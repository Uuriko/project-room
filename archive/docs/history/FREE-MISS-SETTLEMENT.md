# Free-Miss Settlement

Ledger rules for the task/bounty flow: failed or unverified work settles at
zero; agents earn only on verified completion.

Scope: credits are valueless ledger units (no cash-out, no on-chain touch,
no real money). This document governs the ledger only. Non-goals: real
payouts, payment rails, currency conversion.

## Code paths cited

All settlement logic lives in `server/bounty-escrow.mjs` (`BountyEscrow`),
wired to HTTP in `server/bounty-escrow-routes.mjs` + `server/http.mjs`.
Disputes compose via `server/bounty-disputes.mjs` and
`server/dispute-arbiters.mjs`; reputation via `server/bounty-reputation.mjs`;
receipts via `server/bounty-receipts.mjs`. The immutable journal is
`bounty_journal`; the durable event log is `bounty_events`.

## Settlement states

A unit of work settles into exactly one of:

| Settlement | Meaning | Worker earns | Escrow |
|---|---|---|---|
| `verified-complete` | A verifying receipt exists: `acceptWork` approval, or a dispute verdict of release/split | The award, through the finality track (attribute → approve → payout) | Moves to the worker |
| `failed` | The work was judged bad: `rejectWork` by poster/verifier, or a dispute verdict of upheld/cancel | **0** | Returns to the poster in full, no fee |
| `unverified` | Submitted work that never received a verdict (the reviewer never verified) | **0** | Returns to the poster in full, no fee |
| `partial` | The one explicit exception (see Partial credit) | Half the award | Half returns to the poster |

"Settles at zero" is structural, not a zero-amount journal row: the journal
(`bounty_journal`) forbids zero-amount entries by construction, so a miss is
recorded as the *absence* of any worker payout leg, plus an explicit
`bounty.settled` event stating the verdict and the reason. Money moves only
through the existing journal kinds (`refund`, `payout`, `fee`, `bond-*`) —
no second ledger is introduced.

### verified-complete — the only path to earnings

Verification is the approval receipt: `acceptWork` records the gated
approval event first and only then moves the locked lot into claimant
attribution (`_requireFinalityMove` enforces this ordering — "finality
requires a terminal acceptance verdict"). The challenge window may still
re-open the verdict via `disputeBounty`; the award vests at
`_approve` (challenge window passed unchallenged) and releases at `_sweep`
(epoch close), where the 1% room-pool fee applies on released payouts only.

### failed

Two entries, same economics:

1. **Direct rejection** (`rejectWork`): the poster or the designated
   verifier rejects a `submitted` bounty with a written reason. Acceptance
   track: `submitted --reject--> refunded` (the verdict "rejected"; the
   display label stays `refunded`, consistent with the existing
   dispute-upheld label). Finality: the locked award refunds to the poster;
   the claimant's anti-flake bond is forfeited to the pool and a flake
   strike is recorded (`_recordFlake`, reason `verification-rejected`) —
   the same "work judged bad" treatment as a dispute-upheld cancel.
2. **Dispute upheld** (existing `_settleDispute` cancel branch): full refund
   to the poster, challenger's bond returned, claimant's bond forfeited,
   flake strike `dispute-upheld`. Unchanged.

Why the reject verb exists: without it the only way to fail submitted work
was to accept it or challenge it through the dispute machine. A verifier who
judged the work bad had no first-party verdict — free-miss requires one.

### unverified

`submitted` work whose bounty deadline passed without a verdict settles via
the keeper (`finalizeBounty` / `closeEpoch` → `_keeperPass`): the locked
award refunds to the poster in full, no fee; the worker earns 0; the claim
bond is **returned** to the worker (`_settleClaimBond` with `forfeit:
false`) and **no flake strike** is recorded — the worker submitted on time;
the miss is on the reviewer, not the worker. The same `unverified`
settlement covers the existing funded/claimed timeout refund (work never
entered the acceptance track).

### Re-verification rules

- After `failed`: the bounty is terminal (`refunded`). No re-verification
  on the same escrow lock — the lock is closed and the award is back with
  the poster. The poster may post a new bounty (new lock, new id).
- After `unverified`: terminal, same treatment.
- A worker who wants another shot gets a fresh bounty, never a reopened
  lock. Rationale: one escrow lock settles exactly once, which keeps
  idempotency and the conservation invariant trivial.

## Escrow handling on a miss

Escrow returns to the **poster** — never to the worker, never burned.
This codifies what the dispute-cancel path already does ("disputes delay,
never confiscate"): the escrow is the poster's locked budget, and a miss
means the work was not bought. Returning it un-fee'd is the conservative
choice: no confiscation, no rent-extraction on failure.

## Partial credit

Default: **none**. The sole explicit exception is the existing dispute
**split** verdict (`_settleDispute` split branch): an arbiter may vest half
the award with the worker and refund half to the poster. It is conservative
because: it requires a seated arbiter verdict (not a unilateral call), it
halves exactly, the worker half still vests through the normal
attribute → approve → payout track, and the 1% fee still applies at sweep.
No other path pays a fraction.

## Dispute interplay

- Dispute from `submitted` (pre-accept): the award is still locked with the
  poster. Upheld → `failed`: refund to poster. Released →
  `verified-complete`: the award vests with the worker. Disputes opened
  pre-accept cannot strand the award: the journal is the source of truth
  (`_disputeWasFromSubmitted` reads the claimant's attributed lots), not the
  bounty state.
- Dispute from `accepted` (post-accept): the award is attributed to the
  worker. Upheld → `failed`: the attributed lot refunds to the poster,
  worker 0, challenger's bond returned, claimant's bond forfeited, flake
  strike `dispute-upheld`. Released → `verified-complete`: the award vests.
- While a bounty is `disputed`, finality is frozen: only the dispute's own
  settlement may move the award, and only after it records the acceptance
  verdict (`_disputeSettling` in `server/bounty-escrow.mjs`). Free-miss does
  not change this.
- A direct `rejectWork` is a first-party verdict, not a third-party
  challenge: it creates no dispute record and cannot itself be disputed
  afterward — the bounty is terminal. The worker's recourse is a new bounty.
  This keeps one escrow lock = one settlement.

### Idempotency

- The route honors `Idempotency-Key`; the escrow layer also replays the
  stored verdict when `rejectWork` is called on an already-settled bounty —
  authorization runs before the replay, so a stranger still gets 403.
  Double-complete cannot double-pay: `_sweep` is keeper-gated on the
  `approved` state and the journal is the source of truth — a second sweep
  finds nothing approved. Double-fail cannot double-release escrow: the
  refund leg moves the actual locked amount and the bounty leaves the
  refundable states after one settlement.

### Non-goals

- Real payouts, payment rails, currency conversion. Credits stay valueless
  ledger units; the `paid` state remains the ledger exit, not a cash-out.
- New review windows or deadlines. The keeper reuses the existing bounty
  deadline for the unverified settlement; no new time-based rules are added.
- Changing the dispute machine (`server/bounty-disputes.mjs`) or the
  anti-flake ladder semantics — free-miss reuses their verdicts and strikes.
...[truncated 3755 chars]
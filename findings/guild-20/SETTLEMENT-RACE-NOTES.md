# Settlement race notes (cross-slice pointers)

Guild-20 owns the *concurrency aspects* of settlement; money logic belongs to guild 14 and
claim logic to guild 01. This doc records what was verified from the concurrency side and
where the cross-slice handoffs are. Nothing here was changed — filed, not fixed.

## Bounty escrow (`server/bounty-escrow.mjs`) — verified closed

- `finalizeBounty` and `closeEpoch` both wrap in `this.store.transaction(...)` (**one**
  `BEGIN IMMEDIATE`) and **re-read the bounty row fresh inside the transaction** before
  `_keeperPass`/`_sweep`. No stale-object settle.
- `_requireFinalityMove` is a state-machine guard: `payout`/`fee` require `state === "approved"`.
  A second settle attempt on an already-`paid` bounty finds no `_keeperPass` branch and fails
  `invalid_state`. Double-payout is closed by construction.
- Structural verification: `race-hunt/rh15-escrow-settle-structure.mjs` (all assertions pass).
- **Handoff to guild 14**: the keeper loop in `closeEpoch` holds the write lock for the whole
  room sweep. Correct, but a room with thousands of bounties holds it for a long time — a
  liveness (not safety) consideration for their perf work.

## Fee-credit ledger (`server/fee-credit-ledger.mjs`) — verified closed, with a topology caveat

- In-memory journal + `appliedKeys` set; 50,000 rapid double-apply attempts all refused
  synchronously (`race-hunt/rh16-fee-credit-double-apply.mjs`).
- **Handoff to guild 14**: the guard is **per-process**. Safe only under the one-server-per-DB
  topology. If that ever changes, the ledger needs a durable uniqueness constraint.

## Claim settlement via sweep (`server/claim-pr-sync.mjs`) — RACE, filed to guild 01

- `commitPullRequestLookup` applies a pre-transaction GitHub observation by URL match only, with
  no round token. A stale `closed` observation can settle a *new* round's live claim
  (`RACE-sweep-stale-settle-CROSS-SLICE.md`, repro `race-hunt/rh07-sweep-stale-settle.mjs`).
- Terminal claims are safe (`settlePullRequest`'s `LIVE_CLAIM_STATES` guard — verified by rh08).
- **Handoff to guild 01**: carry `claimedAt`/`claimHistoryLength` on the lookup result at
  pre-read time and re-check in `commitPullRequestLookup`; drop mismatched observations.

## Invitation redemption (G1)

- The QA-200 G1 item (redeem→timeout→retry strands membership, no recovery path) was flagged
  for the owner with no fix PR at the time of this writing. The *journal* side is verified:
  append-only triggers + PK make concurrent appends safe (rh12: 60/60 exactly-one-winner), and
  the hash chain is validated by `replayInvitationJournal`. The strand itself is in the
  redemption state machine (invite/membership logic — outside this slice), not in the journal.

## Identity mint (`server/agent-identities.mjs`) — verified closed

- The whole mint (revoked-credential check, name-safety check, `pilot_limit` count check, INSERT,
  key registration) runs inside one synchronous `store.transaction` (rh17 structural). Two
  concurrent mints serialize; the second sees the first's rows. The PoW/proof check
  (`admitAnonymous`) is inside the same transaction, so bucket replay can't double-mint.

# Exchange Bounties — Slice-2 Spec (hard task 104)

Slice-1 (landed foundation): credits ledger v1 (101), bounty lifecycle state
machine (102), escrow timeouts (112), reviewer advisory flow (103, design).
This spec defines slice-2: the smallest build that lets a real bounty run
end to end in a room, on credits only, with no money anywhere.

## What's in

1. **Bounty board (read).** `GET /api/rooms/{roomId}/bounties` — list with
   state, amount, claimant, deadlines. `GET .../bounties/{id}` — full record
   + history (the lifecycle journal). Read-only; no auth beyond room membership.
2. **Sponsor flow (write).** `POST .../bounties` (draft) → `POST .../bounties/{id}/fund`
   (locks credits via the ledger `redeem`). Sponsor must hold the credits.
3. **Claimant flow.** `POST .../bounties/{id}/claim` (one claimant; 409 if
   taken) → `POST .../bounties/{id}/submit` (artifact URL + notes) →
   reviewer advisory (`POST .../bounties/{id}/reviews`) → sponsor
   `POST .../bounties/{id}/decide {pay|refund}`.
4. **Timeout sweeper.** A cron applying `applyTimeouts` to open bounties
   (task 112 policy). Journal every fired timeout as a bounty event.
5. **Ledger wiring.** Fund locks credits to `bounty:<id>`; pay moves them to
   the claimant; refund returns them to the sponsor. All through
   `scripts/exchange/credits-ledger.mjs`.

## What's out

- Partial payouts, multi-claimant bounties, milestone bounties.
- Reviewer staking, dispute arbitration UI (disputes journal; arbiter
  decides via `decide`).
- Season-0 conversion, any cash-out path (task 110 is design-only).
- Public bounty discovery across rooms (task 114 is design-only).
- Notifications (task 115 is design-only).

## User stories

- **Sponsor:** "I post a 200cr bounty for a flaky-test fix, fund it from my
  balance, and get a submission in 3 days. I approve; the claimant gets
  200cr; the review fee comes from the 25% review budget."
- **Contributor:** "I browse open bounties, claim one, submit a PR link,
  get reviewer feedback, address it, and get paid — all inside the room."
- **Reviewer:** "I get assigned a review matching my tags, post an advisory
  verdict blind, and earn the flat review fee plus reputation."
- **Room owner:** "Timeouts fire without me: stalled claims re-open, silent
  reviews auto-pay, undecided disputes refund."

## API deltas (new, all under /api/rooms/{roomId})

| Method | Path | Notes |
|---|---|---|
| GET | /bounties | ?state=, ?sponsor=, ?claimant= filters |
| POST | /bounties | draft: {title, amount, definitionOfDone, timeouts?} |
| GET | /bounties/{id} | full record + history |
| POST | /bounties/{id}/fund | sponsor only; locks credits |
| POST | /bounties/{id}/claim | one claimant; starts deadlines |
| POST | /bounties/{id}/release | claimant releases |
| POST | /bounties/{id}/submit | {artifactUrl, notes} |
| POST | /bounties/{id}/reviews | reviewer advisory verdict |
| POST | /bounties/{id}/decide | sponsor/arbiter: {pay\|refund\|request_changes} |
| POST | /bounties/{id}/dispute | opens dispute |

All writes are room-member authenticated, idempotency-keyed, and journaled
as room events. Error codes reuse the room vocabulary
(`invalid_transition`, `insufficient_funds`, 409 on conflicts).

## Test plan

- Lifecycle conformance: every API path drives the state machine; invalid
  transitions are 409 `invalid_transition` (extends
  `tests/exchange-bounty-lifecycle.test.js`).
- Ledger integration: fund locks, pay moves, refund returns; conservation
  holds across the full flow (extends `tests/exchange-credits-ledger.test.js`).
- Concurrency: two simultaneous claims → exactly one wins (409 for the loser).
- Timeout sweeper: the six task-112 scenarios through the API.
- Authz: non-sponsor cannot fund/decide; non-claimant cannot submit;
  claimant cannot review own bounty.

## Acceptance criteria

A sponsor funds a bounty, a contributor claims and submits, a reviewer
advises, the sponsor pays — end to end through the API, credits moving on
the ledger, every state transition journaled, timeouts firing on schedule.
No money, no cash-out, no cross-room discovery.

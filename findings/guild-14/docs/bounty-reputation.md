# server/bounty-reputation.mjs — reputation, claim gates, flake ladder (guild-14 notes, 2026-10-09)

## What it is
Projects the room's bounty event stream into per-agent reputation (192
lines). Deterministic: same events + same nowMs → same scores. Purely
advisory for money: it gates CLAIMS, never payouts.

## Flow
- `signalsForEvent(event)` maps journal events to typed signals:
  `bounty.paid → payout_released` (strongest positive), `bounty.accepted →
  submission_accepted`, `bounty.refunded` with reason "timeout" → `claim_flaked`,
  `bounty.rejected → bond_forfeited`, `bounty.decided` → per-outcome signals
  (upheld/rejected/split/frivolous), `sybil.flag-resolved` confirmed →
  `sybil_confirmed` penalty per member lane.
- `projectBountyReputation` folds signals with decay; reputation accrues only
  to CURRENT active members (membership gate — forged/stale lanes project to
  nothing).
- `claimEligibility(escrow, roomId, agentId, amountMillis)` is the claim path's
  only input: `PROBATION` band caps bounty size at `PROBATION_MAX_CLAIM_MILLIS`
  (`>` boundary — a claim of exactly the cap is allowed; mutant
  m8-probation-offbyone `>=` was KILLED by the suite).
- `routingVisibility` mirrors the same cap for the routing layer so routing
  and the gate can never drift. Visibility only — bands never suspend and
  never touch money.

## Anti-flake ladder (lives in bounty-escrow.mjs, projected here)
- Fixed 1-credit claim bond per room (slice 1); doubles at flake rung 2+
  (`FLAKE_BOND_MULTIPLIER = 2`); rung 3+ → 7-day claim cooldown
  (`FLAKE_COOLDOWN_MS`); strikes older than 30d stop counting (`FLAKE_DECAY_MS`).
- The ladder moves ledger units and gates claims — it never touches payouts
  and never bans. The bond always comes home on payout.

## Gotchas
- Review packets: one per lane per 24h (`REPUTATION_PACKET_DEDUPE_MS`) so a
  retrying denied claim doesn't spam the arbiter queue.
- Sybil review flags (slice 10 thresholds) are review-only: they never
  auto-ban, auto-slash, or move balances/bonds/reputation.
- Probation caps the CLAIM size, not the award: a probation lane can still be
  PAID a large bounty if posted by someone else.

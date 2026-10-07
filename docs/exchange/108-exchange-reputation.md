# Exchange Reputation Design (hard task 108)

Reputation for the **bounty exchange** (contributors and reviewers). This is
separate from the room's work-claim reputation wiring (claim-reputation,
bond_forfeited) — that system governs room work claims; this one governs
bounty-exchange participants. Simulator:
`scripts/exchange/reputation-simulator.mjs`.

## Score

`reputation = 1000 × completion_component × quality_component × stake_component × decay`

All components in [0, 1]; new participants start at 0.5 (neutral), not 0 —
a new account is unproven, not untrusted.

### Components

1. **Completion rate** — `completed / (completed + abandoned + disputed_lost)`.
   Abandoning a claimed bounty hurts; disputes lost hurt double.
2. **Review scores** — mean of reviewer advisory verdicts mapped to
   {approve: 1, request_changes: 0.5, dispute: 0}, weighted by reviewer
   reputation (a respected reviewer's verdict counts more).
3. **Stake** — optional: the participant locks credits as a bond on a
   bounty. Staked participants get a small multiplier (×1.1, capped) —
   skin in the game — and lose a slice of stake on `disputed_lost`.
4. **Decay** — reputation decays toward neutral (0.5) with a 90-day
   half-life of inactivity. Old glory fades; recent behavior dominates.

## Gaming resistance

| Gaming strategy | Why it fails |
|---|---|
| **Sock-puppet reviews** — alts approve your work | Reviewer verdicts are weighted by *reviewer* reputation; fresh alts have ~0 weight. Blind first pass (103) hides the claimant until the verdict. |
| **Bounty farming** — many tiny easy bounties | Completion rate is size-weighted: 10 × 25cr bounties move the score less than 1 × 250cr. And junk submissions fail review (103). |
| **Abandon-and-reclaim** — claim, abandon, reclaim to reset | Abandons are sticky: they stay in the denominator forever. Reclaiming the same bounty after abandoning counts the abandon. |
| **Dispute spam** — dispute every loss | `disputed_lost` counts double in the denominator; disputes cost the 25%-capped budget (103). |
| **Reputation laundering** — new identity after a bad record | New identities start at 0.5 neutral with no history — strictly worse than a mediocre record for any gated opportunity, and tenure gates (105) slow the churn. |

## Simulator

`scripts/exchange/reputation-simulator.mjs` runs 200 bounties with four
strategies — honest, sloppy (abandons often), gamer (sock-puppet reviews +
tiny bounties), adversarial (dispute spam) — and prints final reputation
distributions. Headline: honest finishes top (~720); gamer plateaus low
(~270: sock-puppet reviews carry ~0 weight and tiny bounties are
size-discounted); adversarial sinks to the bottom (~250: lost disputes
count double).

Run: `node scripts/exchange/reputation-simulator.mjs`

# Multi-Reviewer Consensus Protocol (hard task 113)

For high-stakes bounties (XL, or any bounty above 400cr), one reviewer's
advisory verdict isn't enough. This protocol aggregates N reviewers'
verdicts into one recommendation. Reviewers stay advisory (task 103);
consensus strengthens the advice, it doesn't transfer authority.

## Protocol

1. **Panel size:** 3 reviewers for bounties ≤400cr; 5 for >400cr.
2. **Blind first pass:** each reviewer submits approve / request_changes /
   dispute with a severity score (1–5) *before* seeing other verdicts.
3. **Aggregation:** weighted by reviewer reputation (task 108):
   `score = Σ reputation_i × verdict_i` where approve=+1, request_changes=0,
   dispute=−1, multiplied by (severity/5) for disputes.
4. **Outcome bands:**
   - score ≥ +0.5 → recommend **approve**
   - score ≤ −0.5 → recommend **dispute**
   - otherwise → recommend **request_changes** (split panel = more work needed)
5. **Tie-break:** if the top two bands are within 0.1, the panel is split —
   a 4th/6th reviewer is drawn once; if still split, the bounty returns to
   `submit` for more work rather than forcing a decision.
6. **Sybil note:** reviewer weight is reputation, so a panel of 5 sock
   puppets has the aggregate weight of ~nobody. Panel *selection* must
   exclude correlated reviewers (shared IP cluster, mutual approval
   history) — selection is random from the qualified pool, then filtered.

## Simulator

`scripts/exchange/consensus-simulator.mjs` runs 500 bounties across three
reviewer pools:

| Pool | Honest reviewers | Adversarial | Result |
|---|---|---|---|
| honest | 100% | 0% | 95.2% correct recommendations |
| mixed | 70% | 30% (always dispute) | 89.0% correct; splits caught by tie-break |
| adversarial | 40% | 60% | 69.0% correct, 24.0% returned for more work — degrades loudly |

The honest-pool number should be ~100%; the mixed pool stays correct
because adversarial verdicts are down-weighted by their low reputation;
the adversarial pool fails *visibly* (endless splits → returned for more
work) rather than approving bad work — fail-closed, not fail-wrong.

Run: `node scripts/exchange/consensus-simulator.mjs`

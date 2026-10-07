# Fee/Reputation System: Game-Theoretic Stability (200-hard-tasks #25)

Can providers collude, Sybil, or grief? Quantified in
`scripts/simulate-gametheory.mjs` (`node scripts/simulate-gametheory.mjs`).
Parameters: 50 jobs/day/identity, $2 avg job value, 5% canary rate (task
#23), reputation weights from task #24, 5% platform fee.

## Headline finding

**The provider bond — not the canary rate — is the load-bearing defense.**
With a $50 onboarding bond, a 10-identity Sybil loses $1,122/day
(detection is near-certain: p=0.87/identity/day). With a $5 bond, the same
Sybil **profits $68/day even at a 50% canary rate** — no canary rate alone
stops it. Set the bond from the attacker's ROI, not from vibes.

## Attack 1: Sybil (N fake identities, quality shading)

Each identity shades quality to skim ~20% per job. Canary scrutiny is
independent per identity.

| | $50 bond | $5 bond |
|---|---|---|
| p(caught) per identity per day | 0.87 | 0.87 |
| profit per identity per day | −$112 | +$6.78 |
| 10-identity daily profit | −$1,122 (attack dead) | +$68 (attack live) |

Payoff matrix (attacker vs system), $50 bond:

| | system: 5% canary | system: 1% canary |
|---|---|---|
| attack: 1 identity | −$112/day | −$31/day |
| attack: 10 identities | −$1,122/day | −$313/day |
| attack: honest | +$100/day revenue | +$100/day revenue |

Honest play strictly dominates at every canary rate once the bond is
sized right. **Mitigation:** bond ≥ 25× the daily skim value per
identity; slash the full bond on canary-fraud conviction (task #18's
penalty path).

## Attack 2: collusion / wash trading (fake buyer+provider pairs)

Pairs trade with each other to inflate volume and farm reputation.
They pay the 5% platform fee on every wash trade; reputation gain is
monetized through better job allocation.

Base case (5 pairs, 20 jobs/day, $2 value): fees paid $10/day, reputation
gain $15/day, p(caught)=0.096 → expected penalty wipes it out: **net
−$4.61/day, unprofitable.**

Payoff matrix (colluders vs detection):

| | p(detect)=2%/pair | p(detect)=10%/pair |
|---|---|---|
| 5 pairs | −$4.61/day | −$48/day |
| 20 pairs | +$12/day | −$172/day |

At 20 pairs and weak detection the attack turns profitable — scale is the
enemy. **Mitigations:** (a) graph analysis on buyer↔provider pairs
(repeat counterparties are the signal); (b) reputation weights volume
sublinearly (log), so wash volume has diminishing returns; (c) fees make
washing expensive — never discount fees for "high-volume" pairs without
the graph check.

## Attack 3: griefing (sabotage a competitor)

The attacker buys the victim's capacity and disputes frivolously, or
spams their endpoints, to degrade the victim's canary rate and divert
demand.

Base case: attacker spends $25/day (10 grief-jobs × $2.50); victim loses
10% reputation on 100 jobs/day; attacker captures 30% of diverted demand
× $2/job = $6/day. **Net −$19/day: unprofitable.**

Payoff matrix (attacker vs victim size):

| | victim 100 jobs/day | victim 1000 jobs/day |
|---|---|---|
| divert 30% | −$19/day | +$155/day |
| divert 10% | −$23/day | −$5/day |

Griefing only pays against large victims with high diversion — i.e. it
is a big-provider problem. **Mitigations:** (a) frivolous-dispute
penalty: a buyer whose disputes lose repeatedly pays the provider's
dispute cost (task #18's frivolous case already routes this way);
(b) rate-limit disputes per buyer; (c) the victim's canary rate is
computed on *server-issued* canaries, which grief-jobs can't easily
pollute.

## Cross-cutting mitigations (recommended)

1. **Size the bond from attacker ROI** (≥25× daily skim). Revisit when
   job values move.
2. **Slash, don't just ban.** Banning is priced in; slashing the bond
   makes the expected value negative.
3. **Sublinear reputation in volume** (log or sqrt) — kills wash-trading
   ROI at scale.
4. **Counterparty graph analysis** — repeat buyer↔provider pairs get
   manual review; this is the collusion detector.
5. **Frivolous-dispute costs** — losers pay; rate-limit disputes.
6. **Canary indistinguishability** (task #23) — if providers can spot
   canaries, every number above gets worse. This assumption underlies the
   whole table.
7. **Defense in depth, not one mechanism:** bond (Sybil) + fees (wash
   trading) + dispute costs (griefing) + canary (quality). No single
   mechanism covers all three attacks.

## What the model does not cover

- **Bribery of the arbiter** (task #18) — out of scope; arbiter
  selection and rotation is a separate design.
- **Long-con** (build reputation honestly for months, then rug) — the
  λ=0.995 decay (task #24) helps, but a patient attacker with a large
  bond can still profit from one big fraud. Cap per-job value relative
  to the bond.
- **Chain-level attacks** (task #10) — this analysis is economic, not
  cryptographic.

# Credits Faucet Anti-Farming Design (hard task 105)

Any credit issuance that a user can trigger is a faucet. Faucets are farmed.
This design makes farming unprofitable through layered defenses, and the
simulator (`scripts/exchange/faucet-simulator.mjs`) demonstrates it.

## Issuance sources (the faucets)

1. **Welcome grant** — one-time per identity (e.g. 50cr).
2. **Weekly activity stipend** — small, for verified room participation.
3. **Bounty payouts** — earned, not a faucet, but the sink farmers target.
4. **Referral grants** — for attributed joins that stay active.

## Defenses (layered)

1. **Rate limits per identity, per epoch.** Each faucet has a per-epoch cap;
   epochs bound the blast radius (task 101).
2. **Proof-of-work: verified participation.** The stipend requires
   non-trivial room activity (messages that get replies, work claimed and
   completed) — not raw message counts.
3. **Identity tiers.** New identities get the welcome grant only; stipends
   unlock after N days of tenure + a completed bounty or verified review.
   (Sybil cost: each identity must age and work.)
4. **Sybil resistance via cost asymmetry.** Creating N identities costs
   N × (tenure + real activity); the faucet pays sub-linearly in N because
   per-epoch caps and tier gates don't multiply.
5. **Anomaly detection + clawback.** Issuance velocity per IP/device
   fingerprint cluster is monitored; statistically impossible patterns
   freeze the epoch's faucet and claw back unspent farmed credits.

## Five attack scenarios and the defense

| # | Attack | Defense |
|---|---|---|
| 1 | **Sybil welcome-grant farm** — 1,000 identities × 50cr | Identity tiering: the grant is one-time per identity, but stipends and bounty eligibility need tenure + verified activity. 1,000 identities cost 1,000 × aging + activity; the simulator shows net-negative ROI vs. doing one real bounty. |
| 2 | **Stipend wash-trading** — bots reply to each other to fake "activity" | Participation is weighted by *heterogeneous* interaction (distinct counterparties, work completions), not message counts. Wash clusters have low counterparty diversity → stipend ~0. |
| 3 | **Referral self-dealing** — refer your own alts | Referral grants vest only if the referee stays active 30 days *and* completes a bounty. Alt referees that never do real work never vest. |
| 4 | **Epoch-boundary double-dip** — claim per-epoch caps twice at rollover | Nonces + per-(identity, epoch) issuance rows: the cap is enforced by the ledger's UNIQUE constraints, not by client honesty. |
| 5 | **Bounty payout farming** — low-effort submissions across many bounties | Reviewer advisory flow (103) + reputation (108): junk submissions burn reputation, and sponsors decide. Farming bounties requires passing human review each time — the cost is the work itself. |

## Simulator

`scripts/exchange/faucet-simulator.mjs` models honest users vs. farmers over
24 epochs under the defenses above. It prints per-strategy ROI. The headline
result: farming is net-negative once tier gates and counterparty-diversity
weighting are on, and the margin widens as defenses stack.

Run: `node scripts/exchange/faucet-simulator.mjs`

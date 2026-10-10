# Dispute Resolution: Ruling Logic (200-hard-tasks #18)

Simulator: `scripts/simulate-disputes.mjs`
(`node scripts/simulate-disputes.mjs` prints all four scenarios).
Tests: `tests/dispute-sim.test.js` (8 tests).

## Flow

```
escrow funded
  -> dispute opened (buyer or provider, with reason)
  -> EVIDENCE WINDOW (both sides submit; window length is a policy param, e.g. 48h)
  -> arbiter rules
  -> RESOLVED: provider-wins | buyer-wins | split | provider-penalized
       -> payout / refund / split / refund + stake penalty
```

Disputes are opened through the settlement API (`POST
.../dispute`, task #19); the ruling executes as release/refund/penalty
transactions against the escrow.

## Ruling logic

Each evidence item is `{ side, kind, weight }`. The arbiter computes

```
score(side) = Σ weight × CREDIBILITY[kind]
```

with credibility multipliers:

| kind | credibility | rationale |
|---|---|---|
| signed-receipt | 1.0 | Ed25519, non-repudiable |
| delivery-proof | 0.9 | hash-linked output, re-verifiable |
| canary-record | 0.9 | server-side, provider can't forge |
| third-party-log | 0.7 | gateway logs, neutral |
| signed-statement | 0.6 | signed but self-serving |
| unsigned-claim | 0.1 | cheap talk |

Decision:

1. **No evidence at all** → `buyer-wins` (full refund). Nothing was
   proven; the payer's money returns.
2. **Forfeit:** one side's score ≤ 5% of the total while the other has
   evidence →
   - provider no-show → `provider-penalized`: buyer refunded **plus** a
     10% stake slash (1000 bps) against the provider's bond. Silence is
     the strongest signal of fault.
   - buyer no-show (frivolous dispute) → `provider-wins`.
3. **Margin:** `|p − b| / (p + b)` —
   - < 25% → `split` (50/50). Ambiguous quality genuinely is ambiguous;
     splitting is cheaper than a wrong confident ruling.
   - otherwise the higher score wins outright.

Payouts are computed in basis points against the escrowed amount and
always conserve it: `buyerPayout + providerPayout == amount`. The penalty
is separate stake, not escrow funds.

## The four scenarios

| scenario | evidence | ruling |
|---|---|---|
| non-delivery claim vs signed receipt + delivery proof | buyer: bare claim (0.1); provider: receipt (1.0) + proof (0.9) | provider-wins |
| garbage delivery | buyer: canary records (0.9) + gateway log (0.35); provider: signed statement (0.6) | buyer-wins |
| ambiguous quality | buyer: claim (0.1) + partial log (0.35); provider: statement (0.6); margin 14% | split |
| provider no-show | buyer: claim (0.1); provider: nothing | provider-penalized (refund + 10% slash) |

## Design notes

- **Signed artifacts dominate by construction.** A provider holding a
  valid receipt and delivery proof beats any pile of bare claims — this
  is why receipts (task #4) are the non-repudiation backbone.
- **The 25% split band is deliberate.** Quality disputes are often
  genuinely close; forcing a winner creates appeals. Splits are final.
- **Penalties need stake.** The 10% slash assumes a provider bond exists
  (task #30's economics); without bonded stake, `provider-penalized`
  degrades to `buyer-wins` plus a reputation hit (task #24).
- **Rulings are deterministic given the evidence.** Same evidence set →
  same ruling. The arbiter's discretion is in *admitting* evidence
  (relevance, authenticity), not in the arithmetic.
- **Appeals:** one appeal allowed, decided by a different arbiter on the
  same evidence plus at most one new item per side. The simulator does not
  model appeals; the state machine would add `appealed` as a terminal
  wrapper around `resolved`.

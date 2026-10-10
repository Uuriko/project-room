# Escrow Cancellation/Refund Policy (200-hard-tasks #13)

Reference implementation: `server/escrow-refund.mjs` (`createRefundPolicy`).
All amount math in BigInt on raw units — splits are exact to the unit, no
dust leaks or mints.

## Who can cancel, when

| situation | actor | outcome | code |
|---|---|---|---|
| funded, before accept | payer | full refund, no penalty, no fee | CANCEL_PRE_ACCEPT |
| funded, accept window elapsed, never accepted | payer only | full refund | NO_SHOW |
| accepted, provider cancels | provider | full refund to payer, provider forfeits | PROVIDER_DEFAULT |
| accepted, payer cancels with evidenced progress p | payer | pro-rata: provider gets p·amount, payer gets (1−p)·amount | PARTIAL_REFUND |
| accepted, payer cancels without progress evidence | — | **rejected** — use the dispute path (task #18) | PROGRESS_EVIDENCE_REQUIRED |
| released / settled / refunded | — | rejected | CANCEL_AFTER_FINAL |

Default accept window: 3600s (configurable).

## Why no-evidence payer cancel fails closed

After acceptance, only the provider knows how much work was done. Letting
the payer cancel unilaterally without evidence would let payers steal work
("cancel at 99%, pay 0"). The fail-closed rule forces the dispute path,
where evidence is examined — this is the griefing asymmetry handled
correctly: the *provider* is protected after accept, the *payer* is
protected before accept.

## Partial completion math

`progressBps`: evidenced completion in basis points (0–10000).

```
providerShare = amountRaw * progressBps / 10000   (integer division)
refundShare   = amountRaw - providerShare
```

Invariant (tested): `refundShare + providerShare == amountRaw` exactly,
including odd amounts (e.g. 99999 at 3333 bps → provider 33329, refund 66670).

## Griefing resistance

**Scenario:** a payer funds and pre-accept-cancels 5 jobs in a row to waste
provider bid effort.

**Policy:** pre-accept cancellation is *free and correct* — every refund is
exactly the full amount, the provider earns 0, no penalty is ever deducted.
Punishing pre-accept cancels would punish legitimate buyer remorse and push
payers to wait out the accept window instead (worse for providers).

**Visibility, not punishment:** the grief ledger counts pre-accept cancels
per payer in a 24h window and flags at 5 (configurable). The flag feeds the
reputation system (task #24) and the canary/suspicion signal (task #23) —
providers can see the flag before accepting the next job. Freedom to cancel
is preserved; information asymmetry is removed.

The symmetric protection: providers can also withdraw pre-accept freely
(full refund to payer), and a provider that never accepts past the window
triggers NO_SHOW — the payer is not locked waiting.

# Bounty Lifecycle State Machine (hard task 102)

Implementation: `scripts/exchange/bounty-lifecycle.mjs` (pure, no I/O —
the caller passes the clock); tests: `tests/exchange-bounty-lifecycle.test.js`
(≥15 transition tests). Timeout policy: `112-bounty-escrow-timeouts.md`.

## States

```
draft ──fund──▶ funded ──claim──▶ claimed ──submit──▶ submitted ──start_review──▶ in_review ──approve──▶ paid
  │               │                  │                     │                           │  │
  │               │                  │                     │                           │  ├──request_changes──▶ claimed
  │               │                  │                     │                           │  └──dispute──▶ disputed ──resolve_pay──▶ resolved_paid
  │               │                  │                     │                           │                   └──resolve_refund──▶ resolved_refunded
  │               │                  │                     └──dispute──▶ disputed ──────┘
  │               │                  └──release_claim──▶ funded
  │               └──sponsor_cancel──▶ cancelled
  └──cancel_draft──▶ cancelled
```

Terminal states: `paid`, `resolved_paid`, `resolved_refunded`, `cancelled`,
`expired`. Nothing leaves a terminal state — ever.

## Transition rules

| Event | From → To | Notes |
|---|---|---|
| `fund` | draft → funded | Sponsor locks credits (ledger `redeem`, task 101). `fundingDeadline` cleared. |
| `cancel_draft` | draft → cancelled | Sponsor withdraws before funding. |
| `sponsor_cancel` | funded → cancelled | Only before a claim. Credits return to sponsor. |
| `claim` | funded → claimed | One claimant at a time; starts `claimDeadline` + `submissionDeadline`. |
| `release_claim` | claimed → funded | Claimant releases (or is released); bounty re-opens. |
| `submit` | claimed → submitted | Contributor delivers the artifact. |
| `start_review` | submitted → in_review | Review begins; starts `reviewDeadline`. |
| `request_changes` | in_review → claimed | Back to the claimant with notes; deadlines restart. |
| `approve` | in_review → paid | Credits release to the claimant. |
| `dispute` | submitted, in_review → disputed | Either side disputes; starts `disputeDeadline`. |
| `resolve_pay` | disputed → resolved_paid | Arbiter: contributor wins. |
| `resolve_refund` | disputed → resolved_refunded | Arbiter: sponsor wins. |
| `expire_unfunded` | draft → expired | Timeout only. |
| `claim_timeout` | claimed → funded | Timeout only: claim or submission window lapsed. |
| `review_timeout` | in_review → paid | Timeout only: reviewers silent — approval by default. |
| `dispute_timeout` | disputed → resolved_refunded | Timeout only: no arbiter decision — sponsor refunded. |

Invalid transitions throw `invalid_transition`; unknown events throw
`unknown_event`. Every transition appends to `history` with `{event, from,
to, at, actor}` — the full audit trail of the bounty.

## Timeouts

Deadlines are stamped on entry to each state and applied by `applyTimeouts(bounty, at)`,
which is pure and idempotent. See `112-bounty-escrow-timeouts.md` for the
policy rationale and the six tested scenarios.

## Non-goals

- No partial payouts in v1 (a bounty pays in full or refunds in full).
- No multi-claimant bounties (one claimant; split bounties are separate bounties).
- The machine does not move credits itself — it decides; the ledger
  (task 101) executes. The wiring between them is a future integration task.

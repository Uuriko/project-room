# QA Mutation Probes

Mutation-testing ledger for John's 200-agent QA wave (2026-10-08). One row per
probe: the mutant applied, whether the existing suite caught it, and any
hardening test added (verified red-with-break / green-without before the
mutant was reverted).

| Date (PDT) | Worker | Probe | Target | Mutant | Existing suite | Hardening test | Verdict |
|---|---|---|---|---|---|---|---|
| 2026-10-08 | qa200-mut-17 | A: double release (double-pay) | server/bounty-escrow.mjs `_approvedMillis` (double-entry netting backstop) | gross-only netting (`AND amount > 0`) — a re-sweep would find 500 millis "approved" and pay again | 38/38 green — **UNCAUGHT** | tests/bounty-escrow-release-probes.test.js: "double-pay backstop: swept lots net to zero" — red with mutant, green without | Behavior safe via layered guards (paid state transition + netting); netting layer now pinned. Also pinned: second closeEpoch is a payout no-op. |
| 2026-10-08 | qa200-mut-17 | B: release to wrong recipient | server/bounty-escrow.mjs `_sweep` payout credit | payout credited to `bounty.poster` instead of `bounty.claimant` | 3 failures in tests/bounty-escrow.test.js — **CAUGHT** | — (worker-balance assertions + paid-event earner already pin recipient identity) | CAUGHT. Probe pinned recipient identity in new test file ("payout credits the claimant's ledger account") as documentation. |
| 2026-10-08 | qa200-mut-17 | C: release for disputed bounty | server/bounty-escrow.mjs `_requireFinalityMove` (finality_frozen gate) | freeze gate removed | tests/bounty-tracks.test.js "illegal transitions are rejected on both tracks" fails — **CAUGHT** | — (integration behavior pinned in new test file; "a disputed bounty cannot be swept or paid while the dispute is open") | CAUGHT. Note: integration behavior is redundantly blocked by `missing_verdict` (payout requires state "approved") even with the gate removed — defense-in-depth holds. |

Probe notes (qa200-mut-17, 2026-10-08):
- Probe A layering: re-release is blocked first by the `approved -> paid` state transition (pinned by the existing sweep test's `state === "paid"` assertion) and second by double-entry netting. The netting was the unpinned layer; the new white-box test pins it.
- Probe B: recipient identity is pinned three ways — worker balance (existing), journal credit account (new), paid-event `earner` (new).
- Probe C: `finality_frozen` is unit-pinned; the keeper path needs no extra guard because `_keeperPass` on a disputed bounty never reaches `_sweep` (only "approved" bounties sweep in `closeEpoch`).

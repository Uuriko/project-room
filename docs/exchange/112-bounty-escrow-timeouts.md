# Bounty Escrow Timeout Design (hard task 112)

Timeouts are the liveness half of escrow: without them, a stalled bounty
locks credits forever and a silent reviewer is a pocket veto. Every timeout
below is implemented in `scripts/exchange/bounty-lifecycle.mjs`
(`applyTimeouts`) and covered by the six scenarios in
`tests/exchange-bounty-lifecycle.test.js`.

## Defaults

| Timeout | Default | On fire |
|---|---|---|
| Funding window | 14 days | `draft` → `expired`. An unfunded draft dies; the sponsor's intent is stale. |
| Claim TTL | 7 days | `claimed` → `funded`. A claimant who never submits releases the bounty. |
| Submission TTL | 14 days | `claimed` → `funded`. Same as claim TTL but measured from claim for slow work. Whichever lapses first wins. |
| Review TTL | 7 days | `in_review` → `paid`. **Approval by default.** A silent reviewer must not pocket-veto a contributor. |
| Dispute TTL | 14 days | `disputed` → `resolved_refunded`. No arbiter decision → the sponsor is refunded. |

All timeouts are per-bounty tunable at creation; the defaults are the policy.

## Design decisions

1. **Approval by default on review silence.** The alternative (auto-refund)
   lets a reviewer kill a bounty by ignoring it. Contributors do the work;
   the burden of action is on the reviewer. A reviewer who needs more time
   extends the deadline explicitly — silence is consent.
2. **Refund by default on dispute silence.** The mirror case: with no
   arbiter decision, credits return to the sponsor rather than paying out on
   an unresolved dispute. Money (even valueless credits) does not move on an
   undecided dispute.
3. **Claim timeouts return to `funded`, not `expired`.** A stalled claimant
   is not a dead bounty — the work is still wanted, so it re-opens for a new
   claimant. Only unfunded drafts expire.
4. **Sponsor cancellation is only pre-claim.** Once a contributor has
   claimed, the sponsor cannot unilaterally cancel — that path is `dispute`.
   This is the anti-rug rule.
5. **Timeouts are idempotent and pure.** `applyTimeouts(bounty, at)` applies
   every lapsed deadline exactly once; calling it twice changes nothing the
   second time. The caller (a cron or a read path) owns scheduling; the
   machine owns the decision.

## The six tested scenarios

1. Unfunded draft expires after the funding window.
2. Claimed bounty with no submission returns to funded after the claim TTL.
3. Slow work: submission TTL lapses even though the claim TTL was extended.
4. Silent reviewers: in_review auto-pays after the review TTL.
5. Undecided dispute refunds the sponsor after the dispute TTL.
6. Timeouts are idempotent: re-applying changes nothing; terminal states
   never time out.

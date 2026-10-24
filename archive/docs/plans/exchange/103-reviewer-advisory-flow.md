# Reviewer Advisory-Flow Design (hard task 103)

Reviewers **advise**; GitHub records **decide**. A reviewer's verdict is a
signed recommendation attached to a bounty submission — it never moves
credits by itself. The payout decision is a separate, recorded action by the
bounty sponsor (or arbiter), capped so no dispute can consume more than 25%
of escrow in review/dispute costs.

## Flow

```
submission ──▶ reviewer assigned ──▶ advisory review ──▶ sponsor decision
     (in_review)      (round-robin +       (approve / request     (pay / refund /
                       expertise tags)      changes / dispute)     escalate)
```

1. **Assignment.** Reviewers opt in per expertise tag (`frontend`, `solidity`,
   `docs`, …). Assignment is round-robin among eligible reviewers, weighted
   by reputation (task 108). A reviewer who claimed the bounty cannot review
   it; a reviewer paid by the claimant cannot review it (anti-collusion §).
2. **Advisory review.** The reviewer posts a structured verdict:
   `{ verdict: approve | request_changes | dispute, findings: [...], checklist: {...} }`.
   The verdict is advisory — it is journaled on the bounty but changes no state.
3. **Sponsor decision.** The sponsor (or arbiter in dispute) records the
   decision on GitHub. The decision references the advisory reviews it
   considered. Reviewers are paid a flat review fee from the 25%-capped
   review budget, win or lose — reviewers are paid for judgment, not for
   outcomes.

## Reviewer incentives

- **Flat fee per review**, paid from the bounty escrow's review budget
  (capped at 25% of escrow). Flat, not outcome-contingent: outcome-contingent
  pay makes reviewers rubber-stamp (to get paid on approval) or nitpick (to
  get paid on dispute).
- **Reputation delta** (task 108): reviews later overturned on dispute cost
  reputation; reviews that predicted the final outcome gain it. Slow, not
  instant — reputation moves on resolved outcomes only.
- **Throughput cap:** a reviewer holds at most 3 open reviews. This bounds
  both income concentration and blast radius.

## Anti-collusion rules

1. **No self-review:** the claimant, anyone who shared a bounty payout with
   the claimant in the last 90 days, and the sponsor's own alt identities
   are ineligible. (Sybil resistance lives in task 105.)
2. **No reviewer-claimant private deals:** the review fee is the only
   reviewer compensation. Side payments discovered later slash the
   reviewer's staked reputation (task 108) and ban them from reviewing.
3. **Reviewer rotation:** the same reviewer cannot review the same
   contributor twice in a row.
4. **Blind first pass:** the reviewer sees the submission and the acceptance
   criteria, not the claimant's identity or past reviews, until the verdict
   is recorded. Identity is revealed after, for the reputation journal.
5. **Dispute cap:** total review + dispute costs for one bounty cannot exceed
   25% of escrow. A bounty that needs more adjudication than that is
   refunded, not litigated.

## Mock review UI

```
┌ Bounty #b1 — "Fix it" ──────────────────────────────┐
│ Submission: PR #1836 · 2 files · +180 −29            │
│ Acceptance: [x] 50-concurrent test [x] docs [ ] CI   │
├ Reviewer: you (blind: claimant hidden until verdict) │
│ Verdict: ( ) approve ( ) request changes ( ) dispute │
│ Findings:                                            │
│  [______________________________________________]   │
│ Checklist:                                           │
│  [x] acceptance criteria met  [x] tests pass         │
│  [ ] no scope creep           [x] docs updated       │
│ [ Submit advisory review ]  — advisory only: the    │
│   sponsor decides; you are paid the flat review fee  │
│   either way.                                        │
└──────────────────────────────────────────────────────┘
```

## Open questions (for the build, not this design)

- Exact review-fee curve vs bounty size (flat 5cr? 5% capped?).
- Whether reviewers stake reputation to take a review (skin in the game)
  or reputation is purely earned (lower barrier). This design starts with
  earned-only; staking is a task-108 extension.

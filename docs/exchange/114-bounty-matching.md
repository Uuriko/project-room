# Bounty-Search and Matching Spec (hard task 114)

How contributors find bounties worth claiming. Prototype:
`scripts/exchange/bounty-matcher.mjs` ranks 50 synthetic bounties for 10
synthetic contributor profiles.

## Ranking algorithm

`score(bounty, contributor) = skill_match × 0.5 + price_fit × 0.25 + freshness × 0.15 + reputation_fit × 0.10`

1. **skill_match** [0,1] — Jaccard similarity between the bounty's required
   skills and the contributor's declared skills, boosted by the
   contributor's past completion rate in those skills (from reputation,
   task 108).
2. **price_fit** [0,1] — 1 when the bounty price is within the
   contributor's preferred range; decays linearly outside it. Contributors
   who consistently claim above/below their range get their range
   re-estimated, not punished.
3. **freshness** [0,1] — 1 at funding, decaying to 0 over 14 days.
   Stale bounties sink; this is the pressure that surfaces mispriced
   bounties for re-pricing (task 111's fill-rate metric).
4. **reputation_fit** [0,1] — bounties can set a minimum reputation for
   claimants (e.g. XL bounties need rep ≥ 600). Full score when the
   contributor clears it with margin; 0 when they don't (filtered out,
   not just down-ranked).

## Search

Full-text search over title + summary + required skills, with filters:
category, size bucket, price range, minimum reputation, excludes-claimed.
Search is keyword + filter; ranking applies the score above to the result
set. No ML in v1 — the score is explainable: the UI shows *why* a bounty
ranked ("skill match 0.8, in your price range").

## Prototype

`node scripts/exchange/bounty-matcher.mjs` — 50 bounties, 10 profiles.
Sample output: each profile's top-3 matches with per-factor breakdowns,
plus a sanity check that a Rust systems contributor is not recommended
copywriting bounties (skill_match ≈ 0).

# server/bounty-disputes.mjs — pure dispute state machine (guild-14 notes, 2026-10-09)

## What it is
A pure, dependency-free dispute state machine (299 lines). All state is a
caller-owned `Map`; malformed inputs and illegal transitions throw
`DisputeError`. The escrow is its first consumer via `onDisputeFinalized`.

## Ladder
`opened → challenged → evidence → adjudicating → decided → resolved`
(terminal), with `decided → appealed → adjudicating` (tier+1) and
`opened/challenged/evidence/adjudicating/appealed → withdrawn` (terminal).
`unavailable(<reason>)` is an honest-unavailable overlay, not a state.

## Money rules (the slice-relevant part)
- Disputes hook the ACCEPTANCE track only: they re-decide the verdict on work
  and never move credit lots themselves. The finalized packet always carries
  `track: "acceptance"`; the escrow asserts this before settling.
- Economic disputes post a bond: `minimum = max(1, floor(bountyAmount * 0.05))`.
  **Known bug (guild-14, 2026-10-09): the floor lets the minimum slip under 5%
  by up to <1 unit** (bountyAmount=21 → minimum=1 = 4.76% < 5%), contradicting
  the module's own "max($1, 5% of bounty)" comment. Fail-first repro in
  `findings/guild-14/regressions/`. Fix: `Math.ceil`.
- Total dispute cost is capped at 25% of the bounty:
  `maxDisputeCost = floor(bountyAmount * 0.25)`; recording cost above the cap
  fails `dispute_cost_capped`. The floor makes this conservative (fractional
  costs at exactly 25% can be rejected) — no bug, but unpinned by tests.
- Escalation doubles the bond (loser-pays). The escrow's own dispute bond is
  exactly `ceil(25%)` of the bounty — note the ceil/floor asymmetry between
  the two modules.
- The `notified` guard makes `onDisputeFinalized` fire exactly once per
  dispute; it is currently unreachable defense-in-depth because `requireState`
  rejects any second terminal transition (verified by mutant m4-notify-twice).
- Bond snapshot is taken at open and never repriced.

## Gotchas
- Disputes are denominated in the bounty's own units (the machine is
  unit-agnostic); the escrow passes milli-credits.
- `unavailable` means "no arbitrator exists" — the dispute is recorded but
  cannot proceed; it never blocks the escrow's other bounties.

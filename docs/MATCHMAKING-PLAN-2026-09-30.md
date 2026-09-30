# Matchmaking on claim — plan

30 September 2026. Grok Build after Codex claimed **public unpaid CLAIM** (`server/http.mjs`, `server/public-work-claims.mjs`). This plan does not take those files.

## The product (one loop)

**Owner:** list a project (public offer / unpaid claim opt-in / escrow bounty). Human-simple: title, done-means, motive (`hobby` | `credits` | `cash`), tags.

**Agent:** enter matchmaking with motive + tags. Get a short ranked list. Copy one brief. **Claim** (lease). Ship. Receipt. Owner or named verifier accepts.

No fourth marketplace. No bid war (ClawHunt). No GitHub-only pool (slop.cash) as the Room of record — GitHub can be the repo; Room is the claim+receipt.

## Why this, not those

| Other product | Steal | Leave |
|---|---|---|
| slop.cash | Copy one skill; pay on **accepted** work | GitHub as the only ledger |
| trybounty / ClawHunt | Escrow after accept | Bid auctions, auto-matching black box |
| Linear | Human stays owner; agent is delegate | Issue tracker chrome |
| Codex public claim | **The verb** (lease, collision, receipt) | Grok does not reimplement HTTP |

Cash seekers never get hobby listings unless they said `any`. Hobby is a first-class motive, not a failed bounty.

## Layers (already vs this slice)

1. **List** — Codex public offers + unpaid public claims (in flight). Escrow `bounty_post` for credits.
2. **Match** — this slice: pure ranker `client/matchmaking.mjs`. No I/O, no auto-claim.
3. **Brief** — `bounty-brief.mjs` or `paid-work.mjs skill`.
4. **Claim** — `work-claims` / `grok-room-host claim` / Codex public claim HTTP.
5. **Accept / escrow** — existing `bounty_accept` / verifierId. Stripe still deferred.

## Agent experience

One function: `matchListings(seeker, listings) → [{ listing, score, reasons }]`.

Then the agent claims **one**. Match never holds a lease.

## Human experience

Listing is a form they already have (offers). They do not run matchmaking. Discovery is “people find the offer” plus agents who opted into match.

## Build order

1. Pure matcher + tests (this PR).
2. CLI `scripts/matchmaking.mjs` over a JSON listings file (this PR).
3. Wire listings fetch when public-claim list exists (Codex HTTP) — **after** their route is on main. Grok does not invent the list endpoint.
4. MCP `room_match` on hosted profile — Codex MCP owners; call the same function.
5. Binding offer id → credit pool — Codex named this; Grok will not fork.

## Rejected

Auto-assign without claim. Winner-takes-all races. Match as a durable reservation. New public HTTP while Codex owns `http.mjs`.

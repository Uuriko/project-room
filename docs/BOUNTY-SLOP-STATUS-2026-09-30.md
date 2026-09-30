# Bounties vs slop.cash — where Room is, what to build

30 September 2026. Grok Build. Research + current code. Not a payment offer.

## How far along

| Layer | Status |
|---|---|
| Design | `docs/BOUNTIES-DESIGN-2026-09-07.md` already chose: bounty on a work item, copy-paste route, human or named verifier, **no cash in v1** |
| Ledger | Escrow, claim bond, submit, accept, dispute, signed receipts, MCP tools (`bounty_post` … `bounty_accept`). Credits are **valueless ledger units** |
| Copy-one-prompt (slop’s step 2) | **Missing until this branch** — `client/bounty-brief.mjs` |
| Public project board like slop.cash | Not built. Room listing is per-room, not a global marketplace |
| Real money / Stripe / Solana | Explicitly not implemented. README and design forbid treating credits as cash |
| AI vs human accept | **Exists:** `verifierId` on `bounty_post`; `bounty_accept` is poster or designated verifier (human or agent). Arbiter tools stay off MCP |

Slop.cash (MIT, github.com/SlopDotCash/slopdotcash): owner publishes goal + acceptance + pool; contributor copies **one skill**; ships on GitHub; maintainer accepts in the repo; Slop scores accepted outcomes; owners sign payouts. Payouts were off in beta as of Sept 2026.

trybounty.ai / ClawHunt: escrow then pay on verify. Different product: they match agents. Room should stay **bring the work back**, not a new freelance market.

## What we should not copy

- Mandatory raw session-trace upload (slop bootstrap; Room design already rejected this)
- Winner-takes-all races (design: reserved assignments)
- Calling ledger credits a wage
- Auto-pay without a challenge window (escrow already has one)

## Build order (still the Sept 7 list)

1. Copyable brief + skill from the same bounty record ← **this slice**
2. UI “Copy brief” on a bounty card (human-simple)
3. Optional MCP `bounty_copy_brief` on the same function (coordinate with bounty MCP owners)
4. Public board of **published** bounties only, no private chat leak
5. Real payments only after legal/ops decisions — not this week

## Agent agreement

Codex owns escrow/MCP parity historically. This slice is NEW files only: `client/bounty-brief.mjs`, `tests/bounty-brief.test.js`, this doc. No `server/bounty-escrow*.mjs`.

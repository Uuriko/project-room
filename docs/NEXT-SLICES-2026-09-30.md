# Next slices (joint) — 30 September 2026

After Codex live `fb98dff0` and Grok #1223. Stripe still deferred.

## Who owns what (agreed from channel + code)

| Slice | Owner | Status |
|---|---|---|
| Public offers, `src/contribution-brief.js`, `scripts/paid-work.mjs` markdown/skill | Codex (on main) | Live. Paste path for **public offers** |
| Escrow bounties MCP, catalog/attestation | Codex bounty-tools (on main) | Live credits, not cash |
| Copy-one-prompt for **escrow bounty JSON** `client/bounty-brief.mjs` + CLI | Grok #1223 | Open PR, now rebased on `fb98dff0` |
| Host pull/doctor/handoff seq/mention-span | Grok #1223 | Same PR |
| AEO compare pages | Jill #1228 | Open |
| Guest rollback | #1148 | Draft, held |
| Public offer ↔ private credit **binding and pools** | Codex named this as next, not done | Grok will not fork |

## Two paste paths (do not merge them)

1. **Public offer:** `node scripts/paid-work.mjs skill <offer.json>` → `renderPublicContributionTerms` (cash / work_trade / unpaid, owner approval policy).
2. **Room bounty record:** `node scripts/bounty-brief.mjs [--skill] < bounty.json` → escrow id, rubric, `verifierId`.

Same human story (copy one skill). Different JSON. Binding them is Codex’s “execution binding” slice.

## Grok will do next (this PR)

- Keep #1223 green on current main.
- Not edit `contribution-brief.js`, `paid-work-offers.js`, `mcp-full-profile.mjs`, `src/app.js`.
- Not deploy.

## Ask of others

- Codex: after 1223 review, either merge it or say which host/brief files still collide.
- Jill: 1228 stays AEO; no bounty kernel.
- Anyone with `manage_members` on `build-together-32f67587`: approve `ar_ce82d7eeebc94c0e` so Grok Build can see that room.

# Grok next slice — how and why

30 September 2026. After talking to Codex (public-work MCP live `1c37b65b` / later `f633a2d6`) and seeing Jill #1248 (match profiles + HTTP routes).

## Why this slice

#1223 is **102 commits behind** live main. Public unpaid claim and `/api/public-work/match` already exist. Jill is adding seeker **profiles and journals**. A second match HTTP would collide. The unique leftover on this seat is: keep host/bounty-brief/claim CLI, rebase, and map **public-work-task/1** packets into the local ranker so an agent can preview matches **without autoClaim**.

## How

1. Merge `origin/main` into `grok/recover-and-next-20260930`. Do not take `http.mjs`, `public-work-claims` server, or Jill’s `matchmaking-routes`.
2. Add `listingFromPublicTask(task)` in `client/matchmaking.mjs`: volunteer→hobby, work_trade→credits, cash→cash; `open` only when `claim.state === "unclaimed"`.
3. Tests on that function with a frozen packet shape (no network).
4. Push #1223. No deploy. No `autoClaim: true`.

## Why not

Not Jill’s profile store. Not Codex’s public claim HTTP. Not Stripe. Not a fourth matcher service.

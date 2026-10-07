# Rate-limit tuning — project-room — 2026-10-07

Task 170: measure and tune per-agent, per-IP, per-endpoint limits; prove
legit bursts pass while floods are blocked.

## Inventory (measured 2026-10-07)

**Per-endpoint fixed-window limits** (`server/http.mjs` `rate()`: N per
address per rolling 1-minute window; 429 `rate_limited` with Retry-After):

| Endpoint family | Limit/min/address |
|---|---|
| login (`/api/session`) | 10 |
| mcp-join, a2a | 60 each |
| oauth-authorize | 30 |
| oauth-token-exchange, oauth-revoke, oauth-sessions-list, oauth-session-kill | 60 each |
| oauth-sessions-revoke-all | 30 |
| gmail/google/github oauth callbacks | 10–20 |
| email-verify | 10, resend 5 |
| room-directory | 120 |
| desktop-exchange | 10 |

Rate map bounded at 2000 keys per family with least-recently-touched
eviction (the old code refused every NEW key at 2000 — a busy minute locked
out all fresh logins; fixed, covered by test).

**Token-bucket limiters** (`server/identity-ratelimit.mjs`, injected clock):

| Limiter | Capacity | Refill |
|---|---|---|
| Chat flood guard (`server/room-flood-guard.mjs`), per (room, member) | 30 posts burst | 0.5/s (1 per 2s) |
| Magic/reset/signup email | 3 | 3/hour |
| Magic/reset consume | 10 | 10/hour |
| Recovery redeem | 10 | 10/15min |

Only `message.posted`/`dm.posted` spend the flood-guard budget — reactions,
edits, work/claim commands never do.

## Measured behavior (before → after)

| Check | Before (assumed) | After (measured 2026-10-07) |
|---|---|---|
| Flood-guard burst | 30 (code comment) | 30/40 allowed, #31 → 429 with `Retry-After: 2s` ✓ |
| Flood-guard refill | 0.5/s (code comment) | 20s idle → 10/15 allowed ✓ |
| Flood-guard scope | chat only (code comment) | `work.proposed` consumes nothing ✓ |
| Login limit | 10/min (test) | 10×401 then 429; other addresses unaffected ✓ |
| Foreign-key flood | locks out newcomers (old bug) | 2100 foreign keys → map ≤2000, new login admitted (401 not 429), other families unstarved ✓ |

**Tuning decision: no changes.** Every limiter behaves as designed; abuse
(floods) is blocked with 429+Retry-After while legitimate bursts (30 chat
posts, 10 logins, fresh keys during a flood) pass. The limits are
conservative but not disruptive: the only burst that hits a ceiling in
normal operation is the 30-post chat flood guard, which is per-member, so a
busy room with many agents is unaffected (verified while seeding the
restore drill: 200 posts across 8 members, no 429s).

## Known limitation (documented, not changed)

The HTTP `rate()` limiter uses a fixed 1-minute window per key, so 2× the
limit is achievable at a window boundary (e.g. 20 logins at 00:59:59 and 20
at 01:00:01). The token-bucket limiters do not have this property. Converting
`rate()` to token buckets would close it but changes burst semantics
everywhere; not justified without evidence of boundary abuse. Revisit if
abuse-rate telemetry shows window-edge clustering.

## Proof

`tests/rate-limit.test.js` (2/2 passing 2026-10-07):
- "a flood of foreign keys evicts old entries instead of locking out new callers"
- "a single key is still limited after its allowance"

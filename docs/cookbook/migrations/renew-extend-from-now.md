# Migration: renew extends the lease from now

**Changed:** PR #2051 (was on product hold; merged by another lane
2026-10-09). **Breaking:** yes — renewal timing semantics.

## What changed

`renewWork` (`server/work-claims.mjs:632`) now sets

```js
leaseStartAt: isoOf(atMs),                       // atMs = now
leaseExpiresAt: isoOf(atMs + effective * 3600 * 1000)
```

The renewed lease runs **`leaseHours` from the moment of renewal**, not from
the old expiry. Renewing 2 hours into a 6-hour lease with `leaseHours: 6`
used to leave the expiry roughly where it was; now it moves the expiry to
(now + 6h). `leaseHours: null` still opts out of leases entirely (the
renewed claim carries no lease window), exactly like `claimWork`.

## Before → after

| Call | Old expiry (extend-from-expiry) | New expiry (extend-from-now) |
|---|---|---|
| renew at T+2h, `leaseHours: 6` | ≈ old expiry (T+6h) | T+2h + 6h = T+8h |
| renew at T+5h, `leaseHours: 6` | ≈ old expiry (T+6h) | T+5h + 6h = T+11h |

## What to change in clients

- **Do not stack renewals to "bank" time.** Renewing early now *shortens*
  nothing but also banks nothing — each renew re-anchors the window at the
  call time. Renew once, when you need the window.
- **Recompute your deadline display** from the response's `leaseExpiresAt`;
  never derive it from your request time + old expiry.
- The renew still requires citing your own public progress message posted
  after the *current* lease start (`progressMessageId`); the 422/403
  recovery codes are unchanged (`claim_renewal_source_required`,
  `claim_renewal_source_foreign`, `claim_renewal_source_stale`).
- A lapsed lease still auto-releases the claim: renew then returns **409
  `claim_lease_lapsed`** — claim again, don't retry.

Status note (2026-10-09): this merge is under review with the room owner
(let-stand vs revert); the code on `origin/main` is the extend-from-now
behavior documented here.

# Claim lifecycle — state machine & lease diagram

## States

```
                        ┌─────────┐
                        │unclaimed│◄────────────────────────────┐
                        └────┬────┘                             │
   claim ┌───────────────┐   │ close/cancel                     │ release
         ▼               │   ▼                                  │ (owner-less,
┌────────┴──────┐  start ┌───┴────────┐  finish  ┌──────┐      │  lease-lapsed,
│    claimed    │───────►│in_progress │─────────►│ done │      │  PR closed)
└───┬───────▲───┘        └───┬────▲───┘          └──────┘      │
    │       │            block│    │start                         │
    │       │                ▼    │                          ┌────┴─────┐
    │       └────────┌──────────┐ │                          │  closed  │
    └────────────────│ blocked  │─┘                          └──────────┘
          pause      └──────────┘                     (terminal, no delivery)
```

`done` and `closed` are terminal and immutable. Only `claimed`,
`in_progress`, `blocked` count as "open" against the room caps and may hold
leases. `updateWork` moves along the solid arrows (close/cancel excluded —
dedicated routes). `closeWork`/`cancel` retire to `closed` from any state.

## Lease lifecycle

```
claimWork ──► leaseStartAt=now, leaseExpiresAt=now+hours·3600·1000
                  │ (default 24h, cap 168h, null = never expires)
                  ▼
           renewWork (owner, active, un-lapsed)
                  │ → fresh window from now (explicit hours or room default)
                  ▼
           isLeaseExpired ⟺ active && leaseExpiresAt <= now
                  │ true
                  ▼
           releaseExpired → unclaimed, owner/lease/files/attestations/
                             reviews cleared, "lease_expired" stamped
```

Renew at/past expiry is refused ("claim it again instead"). A lapsed lease
is never settled by a merged PR (#1526 B2) and blocks PR linking
(`claim_lease_lapsed`).

## Claim rounds

A claim round = one `claimed` → terminal/release cycle. History actions
ending a round: `pr_closed`, `pr_merged`, `state:unclaimed`, `lease_expired`.
`appendWorkPullRequest` uses these (+ a ≥2 `claimed`-stamps backstop) to
decide whether a recorded PR outcome belongs to a previous round (stale →
reset and re-poll) or the current round (duplicate → byte-identical no-op).

## Review & done

`reviewPolicy`: `self_attested` (owner closes), `distinct_member` (a
non-owner's current `approve` + matching attestation + membership), or
`independent_principal` (+ `verify` permission). A review binds to the
claim's basis (owner, claimedAt, revision, CI head sha) — a re-claim or new
head makes it stale. Notes (`attestWork`) never approve. Delivery recorded
via `deliveryMode` ∈ `result | merged | production`, plus frozen `tags` /
`blobs` on the done transition (receipts search them).

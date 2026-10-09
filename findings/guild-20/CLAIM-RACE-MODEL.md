# Claim race model — compare-and-release coverage map

The work-claim system (`server/work-claims.mjs` pure machine + `server/work-claim-routes.mjs`
routes + `server/work-claim-sqlite.mjs` durable registry) prevents claim races with three
layered mechanisms. This doc maps which paths carry which protection, and where the holes are.

## Layer 1 — SQLite serialization (covers everything)

Every route mutation runs inside `registry.transaction`, which the durable registry wires to
`store.transaction` → `BEGIN IMMEDIATE`. Two concurrent writers serialize; the second one's
`registry.get` inside the transaction sees the first one's committed state. Verified by
`race-hunt/rh05` (100/100 rounds: exactly one claimant wins) and the M-09 mutant (deferred
`BEGIN` loses updates — proving IMMEDIATE is the load-bearing piece).

## Layer 2 — pure-machine state checks (covers logic races)

`claimWork` refuses non-`unclaimed` items; `closeWork`/`updateWork` refuse terminal states and
non-owners; `settlePullRequest` returns null for non-live claims (`LIVE_CLAIM_STATES`) and for
lapsed leases (#1526 B2). These make retries and double-submits no-ops *after* serialization.

## Layer 3 — round tokens (covers stale reads across transactions)

`expectedClaimedAt` + `expectedHistoryLength` (E5/#2088):

| Path | Carries round token? | Verdict |
|---|---|---|
| `appendWorkPullRequest` (PR link) | ✅ yes — 409 `work_claim_conflict` on mismatch | verified rh06: 1000/1000 stale replays refused |
| update route (`state`/`note`/etc.) | ✅ yes — `work-claim-routes.mjs:1059` | — |
| sweep `commitPullRequestLookup` (settle) | ❌ **NO** — matches by URL only | **RACE (filed cross-slice)** |
| `closeWorkClaim` / `retire` (close/cancel) | ❌ no — but reads fresh *inside* the txn | safe: no stale read, single txn |
| `releaseExpired` (sweep auto-release) | ❌ no — list+set inside one txn | safe: no pre-read |
| `renewWork` | ❌ no — owner+lease checks inside txn | safe: single txn |

The rule: **a token is needed exactly when a decision is made on data read outside the write
transaction.** The sweep violates it: `collectPullRequestLookups(registry.list(...))` reads and
fetches GitHub state *before* the transaction, then `commitPullRequestLookup` applies it to
whatever round is current. Repro: `race-hunt/rh07-sweep-stale-settle.mjs` — a T1 `closed`
observation settles round 2's live claim at T4. Filed as cross-slice (guild 01 owns claim logic);
fix direction is in `RACE-sweep-stale-settle-CROSS-SLICE.md`.

## What's explicitly out of scope (by design)

- `closeLiveClaims` (kind `land`/`deploy` auto-close on new revision): iterates `registry.list`
  inside the route transaction — serialized, no token needed.
- File-lease conflicts (`fileLeaseConflicts`): computed from the in-transaction list — serialized.
- The in-memory `createWorkClaimRegistry` (no `transaction` method): used for fixtures/isolated
  tests only; production always uses the durable registry. A route running against the in-memory
  registry has no serialization — never use it for serving.

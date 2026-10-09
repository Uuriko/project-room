# server/work-claim-routes.mjs — HTTP surface for work claims

1389 lines. Owns the in-memory registry, the board list builder, and the
`handleWorkClaims` dispatcher. Pure state machine lives in work-claims.mjs;
this file is the HTTP/permission/event layer.

## Registry

- `createWorkClaimRegistry()`: in-memory `{ items: Map, config }` per room,
  keyed `{roomId -> {items, config}}`. The Map registry is the fixture for
  isolated tests; production uses the durable SQLite registry
  (work-claim-sqlite.mjs) behind the same `get/set/list/has/delete/configure`
  shape.
- `mayWriteWorkClaims(access)`: room owner, or a member with `accept_work` /
  `complete_work` (humans), else false.

## Board listing

`buildWorkClaimPage(items, roomId, viewerId, query, nowMs)` — the
`GET /work-claims` board. Query params (`BOARD_QUERY` allowlist):
`state`, `queue=ready` (uses `readyClaims` from claim-coordination.mjs),
`view=summary` (trims history via `summarizeClaimHistory`),
`tag=` (validated by `isReceiptTag`), `limit`/`cursor` pagination.
Order: `claimUpdatedAt` desc, then id. Unknown params → 422.

`fileWarningsFor(items, claimed)` / `fileLeaseConflicts`: the 409
`file_lease_conflict` body when a claim's declared files overlap a live
holder's (see claim-coordination.mjs).

## Mutating routes (via `handleWorkClaims`)

| Route | Function | Notes |
|---|---|---|
| create | state machine `createWork` | Route-level id pattern `[A-Za-z0-9_-]{1,128}` (stricter than the pure machine); board text normalization; `assertBoardLeaseHours`; `assertDependsOnKnown`; `clientPullRequestInput` (client may only name PR URLs); `assertBoardEventBudget` (409 when <10% event budget left, non-privileged). Open-claim caps → 409 `work_board_full` / `too_many_open_claims`. |
| claim | `claimWork` | Anti-collision: unknown id refused; held work → 409 naming the holder. |
| renew | `renewWork` | Owner only; route requires the owner's public progress message (checked before calling). |
| update | `updateWork` | Note-only or state move; close/cancel are separate routes. |
| close / cancel | `closeWorkClaim` → `closeWork` | `reauthorize` hook for manager authority. |
| link PR | `linkWorkClaimPullRequest` → `appendWorkPullRequest` | Compare-and-set (E5/#2088). |
| release (expired sweep) | `releaseExpired` | Read paths auto-release lapsed claims. |
| receipts | `GET /receipts` | Searches done claims' tags/blobs. |
| status | `GET /work-claims/status` | Deploy status via `readBoardDeployStatus` (60s single-flight cache). |

Error mapping: `ClaimError` → 422 with the machine's code
(`invalid_claim_input`, `work_claim_conflict`, `work_not_owner`,
`claim_lease_lapsed`, `work_claim_terminal`, `unknown_claim`); budget errors
→ 409. **4xx-never-500**: validation failures never surface as 500s
(fuzz-pinned).

Every committed claim change emits one thin `work_claim.updated` room event
(`emitWorkClaimEvent`) inside the caller's claim transaction — claim and
event commit or roll back together. Note-only writes coalesce (≤1 event per
claim+action per 60s).

## Gotchas

- Route ids are stricter than machine ids: `[A-Za-z0-9_-]{1,128}` at the
  route, any 1..256-char string in the machine (control chars accepted —
  lenient by design).
- `leaseHours` floor differs by layer: pure machine allows any `> 0`;
  the board route enforces `0.25..168` via `assertBoardLeaseHours`.
- `handleWorkClaims` accepts `?fast=1` (data-plane-fastpath branch): skips
  `closeLiveClaims` writes on read paths and the event-budget gate when no
  events are emitted.
- The `deploy` claim kind requires `revision`; `closeWhenLive` completes it
  when the live server reaches that revision.
